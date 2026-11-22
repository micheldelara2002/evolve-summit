import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from '../../shared/accountSecurity.ts';
import { scanBatches } from "../../shared/completeScan.ts";
import { resolveIdentity, identitySetIsComplete } from "../../shared/identity.ts";
import {
  DELETED_NAME,
  DELETED_EMAIL_MARKER,
  DELETED_DOCUMENT,
  anonymizeAuthoredContent,
} from "../../shared/anonymization.ts";

// Account Deletion — exclusão de conta self-service (LGPD), FAIL-CLOSED e
// RESUMÍVEL.
//
// ===== P1-05 (AUD-04) — O QUE MUDOU E POR QUÊ =====
//
// Antes: `resolveIdentity` engolia falha de consulta e devolvia conjunto vazio;
// a exclusão prosseguia e marcava a conta como excluída mesmo sem saber se
// existiam outras Persons daquele usuário. Além disso o processo era um único
// bloco sem estado: uma interrupção no meio deixava a conta parcialmente
// anonimizada, sem forma de retomar nem de provar o que faltou.
//
// Agora:
//   • IDENTIDADE É PRÉ-REQUISITO. Só prossegue com `identitySetIsComplete()`
//     (resolved | ambiguous | no_person, sem falha de leitura). 'partial' e
//     'unavailable' BLOQUEIAM (503, job 'blocked') — a conta NÃO é declarada
//     excluída.
//   • JOB DURÁVEL (AccountDeletionJob). Cada etapa concluída é gravada; a
//     reexecução PULA o que já foi feito e retoma o restante. Progresso que não
//     pôde ser persistido também bloqueia (sem estado não há retomada).
//   • VERIFICAÇÃO FINAL antes de marcar a conta: as Persons não podem ter
//     e-mail/estar ativas, os documentos não podem ter o número original e não
//     pode restar Participant com o e-mail original. Falha → 503, conta ativa.
//   • `account_status='deleted'` é o ÚLTIMO passo, nunca um efeito colateral.
//
// Preservado (intocado): histórico do evento (pontos, ranking, métricas),
// trilha financeira (Payment/Order/RefundRequest), certificados e qualquer
// registro de terceiros. Só é anonimizado o que pertence ao usuário.
//
// Autorização: o alvo é derivado de base44.auth.me() — NUNCA de um user_id do
// corpo. Idempotência: conta já excluída é bloqueada pelo guard.

const BATCH = 500;

// Ordem das etapas. `verify` roda SEMPRE (mesmo que já conste concluída), porque
// é o portão entre "anonimizado" e "conta excluída".
const STEP_ORDER = [
  'person',
  'participants',
  'leads',
  'chat',
  'connections',
  'memberships',
  'notifications',
  'documents',
  'audit',
  'authored',
  'verify',
];

function msg(err) {
  return err?.message || String(err);
}

function parseSteps(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function newCorrelationId(userId) {
  const uuid = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `del_${userId}_${uuid}`.slice(0, 120);
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    // Guard de conta excluída: conta já excluída é bloqueada com 403.
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const dryRun = !!body.dryRun;
    const requestedCorrelation = typeof body.correlation_id === 'string'
      ? body.correlation_id.trim().slice(0, 120)
      : '';

    // ===== 0. IDENTIDADE — PRÉ-REQUISITO (fail-closed) =====
    let identity;
    try {
      identity = await resolveIdentity(base44, user);
    } catch (err) {
      identity = null;
      console.error('[deleteMyAccount] resolução de identidade falhou:', msg(err));
    }
    const correlationId = requestedCorrelation || newCorrelationId(user.id);

    if (!identity || !identitySetIsComplete(identity)) {
      const identityState = identity?.state || 'unavailable';
      if (!dryRun) {
        try {
          await recordBlockedJob(svc, user.id, correlationId, identityState, identity?.lookupErrors || []);
        } catch (jobErr) {
          console.error('[deleteMyAccount] job de bloqueio não gravado:', msg(jobErr));
        }
      }
      return Response.json({
        error: 'Não foi possível resolver todas as identidades desta conta. A exclusão NÃO foi iniciada e a conta permanece ativa. Tente novamente.',
        deleted: false,
        retryable: true,
        correlation_id: correlationId,
        identity_state: identityState,
        lookup_errors: identity?.lookupErrors || [],
      }, { status: 503 });
    }

    const personIds = identity.personIds;
    const personId = identity.linkedPersonId || identity.selfPersonId || null;

    const counts = {
      person: 0,
      participants: 0,
      leads: 0,
      chatMessages: 0,
      chatThreads: 0,
      connections: 0,
      connectionRequests: 0,
      memberships: 0,
      recipients: 0,
      personDocuments: 0,
      auditLogs: 0,
      submissions: 0,
      awardSubmissions: 0,
      jobPostings: 0,
    };

    const ctx = { svc, user, identity, personIds, personId, counts, dryRun };

    // ===== DRY-RUN: só leitura, sem job e sem escrita =====
    if (dryRun) {
      for (const name of STEP_ORDER) {
        if (name === 'verify') continue; // verificação só faz sentido após as escritas
        await STEPS[name](ctx);
      }
      return Response.json({
        ok: true,
        dryRun: true,
        personId,
        identity_state: identity.state,
        counts,
        would_delete: STEP_ORDER.filter((s) => s !== 'verify'),
      });
    }

    // ===== 1. JOB DURÁVEL =====
    let job;
    try {
      job = await findOpenJob(svc, user.id);
    } catch (err) {
      return Response.json({
        error: 'Não foi possível consultar o estado da exclusão (leitura indisponível). Nada foi alterado; tente novamente.',
        deleted: false,
        retryable: true,
        correlation_id: correlationId,
      }, { status: 503 });
    }
    if (!job) {
      try {
        job = await svc.entities.AccountDeletionJob.create({
          user_id: user.id,
          status: 'pending',
          correlation_id: correlationId,
          steps: '{}',
          current_step: '',
          attempts: 0,
          dry_run: false,
          error: '',
          started_at: new Date().toISOString(),
          is_deleted: false,
        });
      } catch (err) {
        return Response.json({
          error: 'Não foi possível registrar o job de exclusão. Nada foi alterado; tente novamente.',
          deleted: false,
          retryable: true,
          correlation_id: correlationId,
        }, { status: 503 });
      }
    }
    if (!job?.id) {
      return Response.json({
        error: 'O job de exclusão não confirmou a gravação. Nada foi alterado; tente novamente.',
        deleted: false,
        retryable: true,
        correlation_id: correlationId,
      }, { status: 503 });
    }

    const steps = parseSteps(job.steps);
    const jobCorrelation = String(job.correlation_id || correlationId);
    const attempts = (Number(job.attempts) || 0) + 1;

    if (!(await saveJob(svc, job, { status: 'running', attempts, current_step: job.current_step || '' }))) {
      return Response.json({
        error: 'Não foi possível registrar o início da exclusão. Nada foi alterado; tente novamente.',
        deleted: false,
        retryable: true,
        correlation_id: jobCorrelation,
      }, { status: 503 });
    }

    // ===== 2. ETAPAS (idempotentes e retomáveis) =====
    for (const name of STEP_ORDER) {
      // `verify` sempre roda: é o portão antes de marcar a conta.
      if (name !== 'verify' && steps[name] === 'done') continue;
      try {
        await STEPS[name](ctx);
      } catch (err) {
        console.error('[deleteMyAccount] etapa falhou:', name, msg(err), '| correlation:', jobCorrelation);
        await saveJob(svc, job, {
          status: 'failed',
          current_step: name,
          error: `${name}: ${msg(err)}`.slice(0, 500),
          attempts,
        });
        return Response.json({
          error: 'A exclusão não foi concluída. A conta permanece ativa e o processo pode ser retomado.',
          deleted: false,
          retryable: true,
          correlation_id: jobCorrelation,
          failed_step: name,
          detail: msg(err),
        }, { status: 503 });
      }

      if (name !== 'verify') steps[name] = 'done';
      const saved = await saveJob(svc, job, {
        status: 'running',
        current_step: name,
        steps: JSON.stringify(steps),
        attempts,
      });
      if (!saved) {
        // Sem progresso persistido não há retomada confiável: para aqui.
        return Response.json({
          error: 'O progresso da exclusão não pôde ser gravado. A conta permanece ativa; repita a operação.',
          deleted: false,
          retryable: true,
          correlation_id: jobCorrelation,
          completed_step: name,
        }, { status: 503 });
      }
    }

    // ===== 3. SÓ AGORA a conta é marcada como excluída =====
    await svc.entities.User.update(user.id, {
      account_status: 'deleted',
      photo_url: null,
    });
    // Best-effort: campo built-in pode rejeitar a sobrescrita; account_status já
    // bloqueia o acesso (guard no AuthContext).
    try {
      await svc.entities.User.update(user.id, { full_name: DELETED_NAME });
    } catch (_) { /* best-effort */ }

    await saveJob(svc, job, {
      status: 'completed',
      current_step: 'completed',
      steps: JSON.stringify(steps),
      attempts,
      completed_at: new Date().toISOString(),
      error: '',
    });

    return Response.json({
      ok: true,
      dryRun: false,
      deleted: true,
      correlation_id: jobCorrelation,
      personId,
      identity_state: identity.state,
      counts,
    });
  } catch (error) {
    console.error('[deleteMyAccount]', msg(error));
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// ===== Job durável =====

async function findOpenJob(svc, userId) {
  const rows = await svc.entities.AccountDeletionJob.filter(
    {
      user_id: userId,
      is_deleted: false,
      status: { $in: ['pending', 'running', 'blocked', 'failed'] },
    },
    '-created_date',
    1,
  );
  if (!Array.isArray(rows)) throw new Error('resposta_invalida');
  return rows[0] || null;
}

async function saveJob(svc, job, patch) {
  try {
    await svc.entities.AccountDeletionJob.update(job.id, patch);
    return true;
  } catch (err) {
    console.error('[deleteMyAccount] falha ao gravar job:', msg(err));
    return false;
  }
}

async function recordBlockedJob(svc, userId, correlationId, identityState, lookupErrors) {
  const existing = await findOpenJob(svc, userId);
  const patch = {
    status: 'blocked',
    correlation_id: existing?.correlation_id || correlationId,
    error: `identidade ${identityState}: ${(lookupErrors || []).join(' | ')}`.slice(0, 500),
  };
  if (existing?.id) {
    await svc.entities.AccountDeletionJob.update(existing.id, patch);
    return;
  }
  await svc.entities.AccountDeletionJob.create({
    user_id: userId,
    steps: '{}',
    current_step: '',
    attempts: 0,
    dry_run: false,
    started_at: new Date().toISOString(),
    is_deleted: false,
    ...patch,
  });
}

// ===== Etapas =====

const participantAnon = (id) => ({
  id,
  full_name: DELETED_NAME,
  email: DELETED_EMAIL_MARKER,
  cpf: null,
  phone: null,
  company: null,
  job_title: null,
  linkedin: null,
  instagram: null,
  youtube: null,
  website: null,
  bio: null,
  is_eligible: false,
});

const leadAnon = (id) => ({
  id,
  participant_name: DELETED_NAME,
  participant_email: null,
  person_phone: null,
  person_linkedin: null,
  person_company: null,
  person_job_title: null,
});

async function pageParticipants(ctx, query, seen) {
  const { svc, dryRun, counts } = ctx;
  for await (const batch of scanBatches(svc.entities.Participant, query, { pageSize: BATCH })) {
    const updates = [];
    for (const p of batch) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      updates.push(participantAnon(p.id));
      counts.participants++;
    }
    if (!dryRun && updates.length > 0) {
      await svc.entities.Participant.bulkUpdate(updates);
    }
  }
}

async function pageLeads(ctx, query, seen) {
  const { svc, dryRun, counts } = ctx;
  for await (const batch of scanBatches(svc.entities.Lead, query, { pageSize: BATCH })) {
    const updates = [];
    for (const l of batch) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      updates.push(leadAnon(l.id));
      counts.leads++;
    }
    if (!dryRun && updates.length > 0) await svc.entities.Lead.bulkUpdate(updates);
  }
}

const STEPS = {
  // 1. PERSON (por id) — limpa toda PII, mantém id + relacionamentos.
  async person(ctx) {
    const { svc, personIds, dryRun, counts } = ctx;
    for (const pid of personIds) {
      const rows = await svc.entities.Person.filter({ id: pid });
      if (!Array.isArray(rows)) throw new Error('leitura de Person inválida');
      const person = rows[0];
      if (!person) continue;
      counts.person += 1;
      if (!dryRun) {
        await svc.entities.Person.update(pid, {
          full_name: DELETED_NAME,
          contact_email: null,
          phone: null,
          company: null,
          job_title: null,
          photo_url: null,
          bio: null,
          linkedin: null,
          instagram: null,
          youtube: null,
          website: null,
          is_active: false,
        });
      }
    }
  },

  // 2. PARTICIPANT (por person_id, depois por email) — preserva id + event_id.
  async participants(ctx) {
    const { svc, identity, personIds, dryRun } = ctx;
    const seen = new Set();
    if (personIds.length > 0) await pageParticipants(ctx, { person_id: { $in: personIds } }, seen);
    if (identity.emailNorm) {
      await pageParticipants(ctx, { email: { $in: identity.emailVariants } }, seen);
    }
    // Guarda os ids anonimizados para a etapa de leads.
    ctx.participantIds = [...seen];
    void svc; void dryRun;
  },

  // 3. LEAD (por person_id, depois por participant_id) — preserva o parceiro.
  async leads(ctx) {
    const { personIds } = ctx;
    const seen = new Set();
    if (personIds.length > 0) await pageLeads(ctx, { person_id: { $in: personIds } }, seen);
    const partIdArr = ctx.participantIds || [];
    for (let i = 0; i < partIdArr.length; i += BATCH) {
      const chunk = partIdArr.slice(i, i + BATCH);
      await pageLeads(ctx, { participant_id: { $in: chunk } }, seen);
    }
  },

  // 4. CHATMESSAGE + CHATTHREAD — preserva o texto, anonimiza o nome.
  async chat(ctx) {
    const { svc, personIds, dryRun, counts } = ctx;
    if (personIds.length === 0) return;
    for await (const batch of scanBatches(svc.entities.ChatMessage, { sender_person_id: { $in: personIds } }, { pageSize: BATCH })) {
      if (!dryRun) {
        await svc.entities.ChatMessage.bulkUpdate(
          batch.map((m) => ({ id: m.id, sender_name: DELETED_NAME })),
        );
      }
      counts.chatMessages += batch.length;
    }
    for (const side of ['person_a_id', 'person_b_id']) {
      const nameField = side === 'person_a_id' ? 'person_a_name' : 'person_b_name';
      for await (const batch of scanBatches(svc.entities.ChatThread, { [side]: { $in: personIds } }, { pageSize: BATCH })) {
        if (!dryRun) {
          await svc.entities.ChatThread.bulkUpdate(
            batch.map((t) => ({ id: t.id, [nameField]: DELETED_NAME })),
          );
        }
        counts.chatThreads += batch.length;
      }
    }
  },

  // 5. CONNECTION + CONNECTIONREQUEST — anonimiza o snapshot do nome.
  async connections(ctx) {
    const { svc, personIds, dryRun, counts } = ctx;
    if (personIds.length === 0) return;
    for (const side of ['person_a_id', 'person_b_id']) {
      const nameField = side === 'person_a_id' ? 'person_a_name' : 'person_b_name';
      for await (const batch of scanBatches(svc.entities.Connection, { [side]: { $in: personIds } }, { pageSize: BATCH })) {
        if (!dryRun) {
          await svc.entities.Connection.bulkUpdate(
            batch.map((c) => ({ id: c.id, [nameField]: DELETED_NAME })),
          );
        }
        counts.connections += batch.length;
      }
    }
    for (const side of ['requester_person_id', 'receiver_person_id']) {
      const nameField = side === 'requester_person_id' ? 'requester_name' : 'receiver_name';
      for await (const batch of scanBatches(svc.entities.ConnectionRequest, { [side]: { $in: personIds } }, { pageSize: BATCH })) {
        if (!dryRun) {
          await svc.entities.ConnectionRequest.bulkUpdate(
            batch.map((c) => ({ id: c.id, [nameField]: DELETED_NAME })),
          );
        }
        counts.connectionRequests += batch.length;
      }
    }
  },

  // 6. EVENTMEMBERSHIP (por person_id, por e-mail e por user_id).
  async memberships(ctx) {
    const { svc, user, identity, personIds, dryRun, counts } = ctx;
    const seen = new Set();
    for (const queryKey of [
      personIds.length > 0 ? { person_id: { $in: personIds } } : null,
      identity.emailNorm ? { user_email: { $in: identity.emailVariants } } : null,
      { user_id: user.id },
    ]) {
      if (!queryKey) continue;
      for await (const batch of scanBatches(svc.entities.EventMembership, queryKey, { pageSize: BATCH })) {
        const updates = [];
        for (const m of batch) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          updates.push({ id: m.id, person_name: DELETED_NAME, user_email: null });
          counts.memberships++;
        }
        if (!dryRun && updates.length > 0) await svc.entities.EventMembership.bulkUpdate(updates);
      }
    }
  },

  // 7. NOTIFICATIONRECIPIENT (por recipient_user_id) — preserva métricas.
  async notifications(ctx) {
    const { svc, user, dryRun, counts } = ctx;
    for await (const batch of scanBatches(svc.entities.NotificationRecipient, { recipient_user_id: user.id }, { pageSize: BATCH })) {
      if (!dryRun) {
        await svc.entities.NotificationRecipient.bulkUpdate(
          batch.map((r) => ({ id: r.id, recipient_name: DELETED_NAME, recipient_email: null })),
        );
      }
      counts.recipients += batch.length;
    }
  },

  // 8. PERSONDOCUMENT (por person_id) — PII mais sensível.
  async documents(ctx) {
    const { svc, personIds, dryRun, counts } = ctx;
    if (personIds.length === 0) return;
    for await (const batch of scanBatches(svc.entities.PersonDocument, { person_id: { $in: personIds } }, { pageSize: BATCH })) {
      if (!dryRun && batch.length > 0) {
        await svc.entities.PersonDocument.bulkUpdate(
          batch.map((d) => ({
            id: d.id,
            document_number: DELETED_DOCUMENT,
            is_primary: false,
            status: "inactive",
          })),
        );
      }
      counts.personDocuments += batch.length;
    }
  },

  // 9. AUDITLOG — anonimiza e-mail/nome nos detalhes (preserva valores/IDs).
  async audit(ctx) {
    const { svc, user, dryRun, counts } = ctx;
    const email = (user.email || "").toLowerCase();
    const name = (user.full_name || "").trim();
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const emailRe = email ? new RegExp(esc(email), "gi") : null;
    const ownNameRe = name.length >= 4 ? new RegExp(esc(name), "gi") : null;
    const anonDetails = (details, ownLog) => {
      let out = String(details || "");
      if (emailRe) out = out.replace(emailRe, "conta_excluida");
      if (ownLog && ownNameRe) out = out.replace(ownNameRe, DELETED_NAME);
      return out;
    };
    const fixLog = (log) => {
      const ownLog = log.user_id === user.id;
      const updates = { id: log.id };
      let changed = false;
      if (ownLog && log.user_name && log.user_name !== DELETED_NAME) {
        updates.user_name = DELETED_NAME;
        changed = true;
      }
      if (log.details && (emailRe || (ownLog && ownNameRe))) {
        const next = anonDetails(log.details, ownLog);
        if (next !== log.details) {
          updates.details = next;
          changed = true;
        }
      }
      return changed ? updates : null;
    };
    for await (const batch of scanBatches(svc.entities.AuditLog, {}, { pageSize: BATCH })) {
      const updates = [];
      for (const log of batch) {
        const u = fixLog(log);
        if (u) {
          updates.push(u);
          counts.auditLogs++;
        }
      }
      if (!dryRun && updates.length > 0) await svc.entities.AuditLog.bulkUpdate(updates);
    }
  },

  // 10. SUBMISSION / AWARDSUBMISSION / JOBPOSTING — autoria anonimizada.
  async authored(ctx) {
    const { svc, identity, personIds, dryRun, counts } = ctx;
    const authored = await anonymizeAuthoredContent(svc, {
      personIds,
      emailVariants: identity.emailNorm ? identity.emailVariants : [],
      dryRun,
      pageSize: BATCH,
    });
    counts.submissions = authored.submissions;
    counts.awardSubmissions = authored.awardSubmissions;
    counts.jobPostings = authored.jobPostings;
  },

  // 11. VERIFICAÇÃO FINAL — nada é declarado excluído sem prova.
  async verify(ctx) {
    const { svc, identity, personIds } = ctx;

    for (const pid of personIds) {
      const rows = await svc.entities.Person.filter({ id: pid });
      if (!Array.isArray(rows)) throw new Error('verificação: leitura de Person inválida');
      const person = rows[0];
      if (!person) continue;
      if (person.contact_email) throw new Error(`verificação: Person ${pid} ainda tem e-mail`);
      if (person.is_active !== false) throw new Error(`verificação: Person ${pid} ainda está ativa`);
    }

    if (identity.emailNorm) {
      const rows = await svc.entities.Participant.filter({
        email: { $in: identity.emailVariants },
        is_deleted: false,
      });
      if (!Array.isArray(rows)) throw new Error('verificação: leitura de Participant inválida');
      const remaining = rows.filter(
        (p) => String(p.email || '').toLowerCase() !== DELETED_EMAIL_MARKER.toLowerCase(),
      );
      if (remaining.length > 0) {
        throw new Error(`verificação: ${remaining.length} participante(s) ainda com o e-mail original`);
      }
    }

    if (personIds.length > 0) {
      const docs = await svc.entities.PersonDocument.filter({ person_id: { $in: personIds } });
      if (!Array.isArray(docs)) throw new Error('verificação: leitura de PersonDocument inválida');
      const leaked = docs.filter((d) => String(d.document_number || '') !== DELETED_DOCUMENT);
      if (leaked.length > 0) {
        throw new Error(`verificação: ${leaked.length} documento(s) ainda com o número original`);
      }
    }
  },
};