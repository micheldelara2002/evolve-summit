// manageParticipant — porta única de escrita do módulo Pessoas (Lote 3.1).
// Valida no servidor: admin OU EventMembership ativa manager/team no evento
// (verifyEventMembership). Todas as escritas de Participant — e os acessos a
// entidades de apoio travadas por RLS (Session read, EventMembership reviewer,
// PersonDocument, Import) — passam por aqui com service role.
// Contadores (maintainBusinessCounter) seguem no frontend, best-effort como hoje.
// F3-08 (rodada de correção 2026-11-12): a auditoria de ROLE_CHANGE — operação
// crítica que o cliente não pode mais registrar (shared/auditLogger) — passou a
// ser gravada AQUI, a partir do contexto confiável da operação (autor
// autenticado, evento do gate, participante alterado e valores old/new).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from '../../shared/accountSecurity.ts';
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";
import { findActiveDuplicateEmails, normalizeParticipantEmail } from "../../shared/participantDedup.ts";
import { grantEventRole, revokeEventRole } from "../../shared/eventInvites.ts";
import { findAccountByEmail, ensurePersonByEmail, inviteToEvent } from "../../shared/accountInvites.ts";
import { buildAuditKey, writeMandatoryAudit, recordPendingTrailVerified, readAuditByKey } from "../../shared/auditTrail.ts";
import { recordAccessChange } from "../../shared/accessAudit.ts";
// (dedup: 1 e-mail ativo = 1 inscrição por evento — validação server-side)
// (conta: quem não tem User recebe convite de cadastro; vínculo no 1º acesso)

const WRITABLE_FIELDS = [
  'full_name', 'email', 'cpf', 'phone', 'company', 'job_title',
  'linkedin', 'instagram', 'youtube', 'website', 'bio',
  'role_in_event', 'registration_status', 'person_id', 'import_id',
  'checkin_status', 'checkin_at', 'checked_in_by_user_id', 'created_day',
];
const ROLE_ENUM = ['attendee', 'speaker', 'team', 'manager', 'partner_rep'];
// Papéis de GESTÃO da equipe: só admin ou o GERENTE do evento atribui/remove.
// 'team' não se descadastra nem cadastra outros membros.
const STAFF_ROLES = ['team'];
const EVENT_STAFF_MANAGER_ROLES = ['manager'];

async function isStaffManager(base44, user, eventId) {
  const { authorized } = await verifyEventMembership(base44, user, eventId, EVENT_STAFF_MANAGER_ROLES);
  return authorized;
}

// P1-04 (AUD-03) — o ciclo de alteração de papel (trilha obrigatória, evidência,
// claim, porta de integridade e reconciliação) vive em shared/roleChange.ts, a
// ÚNICA porta de escrita de `role_in_event`. Este arquivo importa de lá; aqui
// só resta o nome da entidade de evidência, usado pela recuperação de trilha.
const EVIDENCE_ENTITY = 'AccessChangeEvidence';

// F3-16 (2026-11-18) — VÍNCULO CONFIRMADO User ↔ Person.
//
// A F3-15 já não aceitava identidade vinda do corpo, mas ainda provava o titular
// por IGUALDADE DE E-MAIL (conta.email == Person.contact_email ou o snapshot do
// vínculo). E-mail é dado mutável e reutilizável: com vínculos inconsistentes ou
// desatualizados, a coincidência não prova que a conta pertence à Pessoa.
// Regra agora: o e-mail (ou o user_id do vínculo) serve APENAS para LOCALIZAR a
// conta candidata; a prova é o vínculo gravado no cadastro atômico —
// account.person_id === membership.person_id. Sem esse vínculo (conta legada sem
// person_id), a operação é RECUSADA: a regularização é reconceder o acesso de
// avaliador pelo fluxo de convite (grantEventRole), que grava User↔Person.
// Um e-mail coincidente com person_id divergente é recusado.
// O corpo da requisição não participa em nenhuma hipótese.
async function resolveMembershipHolder(base44, membership) {
  const svc = base44.asServiceRole;
  const personId = String(membership?.person_id || '');
  if (!personId) {
    return {
      ok: false,
      reason: 'membership_without_person',
      message: 'Este vínculo de avaliador não tem pessoa associada. Conceda o acesso novamente pelo fluxo de convite.',
    };
  }
  const persons = await svc.entities.Person.filter({ id: personId });
  const person = persons?.[0] || null;
  if (!person) {
    return {
      ok: false,
      reason: 'person_not_found',
      message: 'A pessoa deste vínculo não está disponível. Conceda o acesso novamente pelo fluxo de convite.',
    };
  }
  const personEmail = normalizeParticipantEmail(person.contact_email || '');
  const snapshotEmail = normalizeParticipantEmail(membership.user_email || '');
  const membershipUserId = String(membership.user_id || '');

  // Localização da conta candidata — nunca prova de identidade.
  let account = null;
  if (membershipUserId) {
    const users = await svc.entities.User.filter({ id: membershipUserId });
    account = users?.[0] || null;
    if (!account || account.account_status === 'deleted') {
      return {
        ok: false,
        reason: 'account_unavailable',
        message: 'A conta vinculada a este avaliador não está disponível. Conceda o acesso novamente pelo fluxo de convite.',
      };
    }
  } else {
    const source = personEmail || snapshotEmail;
    if (!source) {
      return {
        ok: false,
        reason: 'identity_missing',
        message: 'O vínculo não tem identidade suficiente para determinar o titular. Conceda o acesso novamente pelo fluxo de convite.',
      };
    }
    account = await findAccountByEmail(svc, source);
    if (!account || account.account_status === 'deleted') {
      return {
        ok: false,
        reason: 'account_not_linked',
        message: 'Não há conta ativa para a pessoa deste vínculo. Conceda o acesso de avaliador pelo fluxo de convite.',
      };
    }
  }

  // PROVA: vínculo persistido entre a conta e a Pessoa do vínculo.
  const accountPersonId = String(account.person_id || '');
  if (!accountPersonId) {
    return {
      ok: false,
      reason: 'account_person_link_missing',
      message: 'A conta deste avaliador não tem vínculo de pessoa confirmado. Conceda o acesso novamente pelo fluxo de convite para regularizar o cadastro.',
    };
  }
  if (accountPersonId !== personId) {
    return {
      ok: false,
      reason: 'identity_mismatch',
      message: 'A conta vinculada pertence a outra pessoa, mesmo que o e-mail coincida. Conceda o acesso novamente pelo fluxo de convite.',
    };
  }

  const accountEmail = normalizeParticipantEmail(account.email || '') || personEmail;
  if (!accountEmail) {
    return {
      ok: false,
      reason: 'identity_missing',
      message: 'A conta deste avaliador não tem e-mail utilizável. Conceda o acesso novamente pelo fluxo de convite.',
    };
  }
  return {
    ok: true,
    email: accountEmail,
    user_id: String(account.id),
    person_link: accountPersonId,
    // Snapshot divergente não invalida o vínculo (a prova é person_id), mas fica
    // registrado na trilha: o snapshot é reescrito com o e-mail atual da conta.
    snapshot_email_mismatch: !!snapshotEmail && snapshotEmail !== accountEmail,
  };
}

function pickFields(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const key of WRITABLE_FIELDS) {
    if (key in data) out[key] = data[key];
  }
  return out;
}

function normDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

async function speakerHasSessions(base44, eventId, participantId) {
  const sessions = await base44.asServiceRole.entities.Session.filter({
    event_id: eventId,
    speaker_id: participantId,
    is_deleted: false,
  });
  return sessions.length > 0;
}

async function resolveUserIdByEmail(base44, email) {
  if (!email) return '';
  try {
    const users = await base44.asServiceRole.entities.User.filter({ email: String(email).trim().toLowerCase() });
    return users?.[0]?.id || '';
  } catch (e) {
    return '';
  }
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    // SEC-004 — guard de conta ativa: conta excluída com token válido é bloqueada.
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const op = String(body.op || '');
    const eventId = String(body.event_id || '');
    if (!op) return Response.json({ error: 'Operação ausente.' }, { status: 400 });
    if (!eventId) return Response.json({ error: 'event_id ausente.' }, { status: 400 });

    // Gate: admin OU membership ativa manager/team neste evento
    const { authorized } = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
    if (!authorized) {
      return Response.json({ error: 'Sem permissão para gerenciar participantes deste evento.' }, { status: 403 });
    }

    if (op === 'create') {
      const data = pickFields(body.data);
      if (!data.full_name) return Response.json({ error: 'Nome é obrigatório.' }, { status: 400 });
      if (!data.email) return Response.json({ error: 'E-mail é obrigatório.' }, { status: 400 });
      if (data.role_in_event && !ROLE_ENUM.includes(data.role_in_event)) {
        return Response.json({ error: 'Papel inválido.' }, { status: 400 });
      }
      data.email = normalizeParticipantEmail(data.email);
      // P0 — Deduplicidade: 1 e-mail ativo = 1 inscrição por evento (servidor).
      const dup = await findActiveDuplicateEmails(base44.asServiceRole, eventId, [data.email]);
      if (dup.size > 0) {
        return Response.json({ error: `"${data.email}" já possui inscrição ativa neste evento (1 e-mail = 1 inscrição).` }, { status: 409 });
      }
      // Papéis de gestão da equipe têm porta própria (assignStaff/removeStaff).
      if (STAFF_ROLES.includes(data.role_in_event) || data.role_in_event === 'manager') {
        return Response.json({ error: 'Papéis de gestão são atribuídos em Equipe do evento.' }, { status: 400 });
      }
      // Cadastro único: a inscrição sempre aponta para a Person do e-mail.
      let person;
      try {
        person = await ensurePersonByEmail(base44.asServiceRole, {
          email: data.email,
          fullName: data.full_name,
        });
      } catch (error: any) {
        if (error?.message === 'identity_ambiguous') {
          return Response.json({ error: 'Há mais de um cadastro de pessoa com este e-mail. Consolide antes de inscrever.' }, { status: 409 });
        }
        throw error;
      }
      data.person_id = person.id;
      // P1-04 (AUD-03) — criação com papel privilegiado passa pela primitiva:
      // evidência ANTES da criação, token/claim na própria criação e trilha
      // obrigatória. Papel default ('attendee') é criação simples.
      let created;
      try {
        const outcome = await createParticipantWithRole(base44.asServiceRole, {
          eventId,
          data,
          actor: user,
          source: 'manage_participant_create',
        });
        created = outcome.participant;
      } catch (error: any) {
        if (error?.message === 'role_evidence_unavailable') {
          return Response.json({
            error: 'Não foi possível registrar a evidência do papel concedido. Nada foi criado; tente novamente.',
            audit_state: 'unavailable',
            applied: false,
          }, { status: 503 });
        }
        throw error;
      }

      // Conta: quem já usa o app é vinculado; quem não usa recebe o convite.
      const account = await findAccountByEmail(base44.asServiceRole, data.email);
      let invite = null;
      if (!account) {
        try {
          invite = await inviteToEvent(base44, {
            eventId,
            email: data.email,
            displayName: data.full_name,
            role: 'attendee',
            actor: user,
          });
        } catch (e: any) {
          invite = { status: 'failed', error: e?.message || 'Falha no envio do convite.' };
        }
      }
      return Response.json({ participant: created, account_linked: !!account, invite });
    }

    if (op === 'bulkCreate') {
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) return Response.json({ error: 'Nenhum registro para criar.' }, { status: 400 });
      if (items.length > 200) return Response.json({ error: 'Lote maior que 200 registros.' }, { status: 400 });
      // P0 — Deduplicidade: duplicatas NO PRÓPRIO LOTE são separadas (não derrubam
      // o lote); duplicatas com inscrição ativa no evento são bloqueadas e
      // devolvidas na resposta para o importador reportar.
      const seen = new Set();
      const duplicates = [];
      const payloads = [];
      for (const it of items) {
        const data = pickFields(it);
        const email = normalizeParticipantEmail(data.email);
        if (seen.has(email)) {
          duplicates.push({ email, reason: 'Duplicado no próprio lote de importação' });
          continue;
        }
        seen.add(email);
        payloads.push({ ...data, email, event_id: eventId });
      }
      const activeDup = await findActiveDuplicateEmails(base44.asServiceRole, eventId, [...seen]);
      const toCreate = [];
      const toCreateIdx = [];
      for (const p of payloads) {
        if (activeDup.has(p.email)) {
          duplicates.push({ email: p.email, reason: 'Já possui inscrição ativa neste evento' });
        } else {
          toCreate.push(p);
        }
      }
      for (const p of toCreate) {
        if (STAFF_ROLES.includes(p.role_in_event) || p.role_in_event === 'manager') {
          duplicates.push({ email: p.email, reason: 'Papéis de gestão são atribuídos em Equipe do evento' });
        } else {
          toCreateIdx.push(p);
        }
      }
      const svc = base44.asServiceRole;
      const emails = [...new Set(toCreateIdx.map((p) => p.email))];

      // PESSOA — uma consulta por lote; o e-mail sem par exato cai no resolvedor
      // único (variantes + ambiguidade recusada).
      const personByEmail = new Map();
      for (let i = 0; i < emails.length; i += 200) {
        const chunk = emails.slice(i, i + 200);
        const rows = await svc.entities.Person.filter({
          contact_email: { $in: chunk },
          is_active: { $ne: false },
        });
        for (const p of rows || []) {
          const key = normalizeParticipantEmail(p?.contact_email);
          if (!key || !p?.id) continue;
          personByEmail.set(key, personByEmail.has(key) ? null : p);
        }
      }

      // CONTA — quem já usa o app é só vinculado.
      const accountByEmail = new Set();
      for (let i = 0; i < emails.length; i += 200) {
        const chunk = emails.slice(i, i + 200);
        const users = await svc.entities.User.filter({ email: { $in: chunk } });
        for (const u of users || []) {
          const key = normalizeParticipantEmail(u?.email);
          if (!key || !u?.id || u.account_status === 'deleted') continue;
          accountByEmail.add(key);
        }
      }

      const ready = [];
      const invites = { sent: 0, failed: 0 };
      const failed_invites = [];
      for (const p of toCreateIdx) {
        let person = personByEmail.get(p.email);
        if (person === null) {
          duplicates.push({ email: p.email, reason: 'Mais de um cadastro de pessoa usa este e-mail' });
          continue;
        }
        if (!person) {
          try {
            person = await ensurePersonByEmail(svc, { email: p.email, fullName: p.full_name });
            personByEmail.set(p.email, person);
          } catch {
            duplicates.push({ email: p.email, reason: 'Não foi possível criar o cadastro da pessoa' });
            continue;
          }
        }
        ready.push({ ...p, person_id: person.id });
      }

      // P1-04 (AUD-03) — itens com papel privilegiado são criados um a um pela
      // primitiva (evidência + trilha); o restante (papel default) vai em lote.
      const PRIVILEGED_CREATE_ROLES = ['speaker', 'partner_rep'];
      const plainReady = ready.filter((p) => !PRIVILEGED_CREATE_ROLES.includes(p.role_in_event));
      const privilegedReady = ready.filter((p) => PRIVILEGED_CREATE_ROLES.includes(p.role_in_event));
      const created = plainReady.length > 0 ? await svc.entities.Participant.bulkCreate(plainReady) : [];
      for (const p of privilegedReady) {
        try {
          const outcome = await createParticipantWithRole(svc, {
            eventId,
            data: p,
            actor: user,
            source: 'manage_participant_bulk',
          });
          created.push(outcome.participant);
        } catch (e: any) {
          duplicates.push({
            email: p.email,
            reason: e?.message === 'role_evidence_unavailable'
              ? 'Não foi possível registrar a evidência do papel privilegiado'
              : 'Não foi possível criar o participante com papel privilegiado',
          });
        }
      }

      // CONVITE — só quem ainda não tem conta. Falha por linha não derruba o lote.
      for (const p of ready) {
        if (accountByEmail.has(p.email)) continue;
        try {
          const res = await inviteToEvent(base44, {
            eventId,
            email: p.email,
            displayName: p.full_name,
            role: 'attendee',
            actor: user,
          });
          if (res.status === 'sent') invites.sent += 1;
          else {
            invites.failed += 1;
            failed_invites.push({ email: p.email, error: res.error });
          }
        } catch (e: any) {
          invites.failed += 1;
          failed_invites.push({ email: p.email, error: e?.message || 'Falha no envio do convite.' });
        }
      }

      return Response.json({
        participants: created,
        duplicates,
        accounts_linked: ready.filter((p) => accountByEmail.has(p.email)).length,
        invites,
        failed_invites,
      });
    }

    if (op === 'update') {
      const participantId = String(body.participant_id || '');
      const data = pickFields(body.data);
      if (!participantId) return Response.json({ error: 'participant_id ausente.' }, { status: 400 });
      if (data.role_in_event && !ROLE_ENUM.includes(data.role_in_event)) {
        return Response.json({ error: 'Papel inválido.' }, { status: 400 });
      }
      const found = await base44.asServiceRole.entities.Participant.filter({ id: participantId, event_id: eventId });
      if (!found.length) return Response.json({ error: 'Participante não encontrado neste evento.' }, { status: 404 });
      let current = found[0];
      // EQUIPE — mexer no papel de equipe (dar ou tirar) é do gerente/admin.
      // Impede que 'team' se descadastre ou promova alguém.
      let changesRole = data.role_in_event !== undefined && data.role_in_event !== current.role_in_event;
      if (changesRole && (current.role_in_event === 'team' || data.role_in_event === 'team' || data.role_in_event === 'manager')) {
        if (!(await isStaffManager(base44, user, eventId))) {
          return Response.json({ error: 'Apenas o gerente do evento pode alterar papéis de gestão da equipe.' }, { status: 403 });
        }
      }
      // P0 — Deduplicidade na edição: trocar o e-mail por um que já tem inscrição
      // ativa no evento é bloqueado (ignora o próprio registro na consulta).
      if (data.email) {
        data.email = normalizeParticipantEmail(data.email);
        if (data.email !== normalizeParticipantEmail(current.email)) {
          const dup = await findActiveDuplicateEmails(base44.asServiceRole, eventId, [data.email], participantId);
          if (dup.size > 0) {
            return Response.json({ error: `"${data.email}" já possui inscrição ativa neste evento (1 e-mail = 1 inscrição).` }, { status: 409 });
          }
        }
      }
      if (data.role_in_event && current.role_in_event === 'speaker' && data.role_in_event !== 'speaker') {
        if (await speakerHasSessions(base44, eventId, participantId)) {
          return Response.json({ error: 'Não é possível alterar o papel: esta pessoa possui sessão associada. Edite a sessão primeiro.' }, { status: 409 });
        }
      }
      const svc = base44.asServiceRole;

      // P1-04 (AUD-03) — a alteração de papel passa pela PRIMITIVA ÚNICA
      // (shared/roleChange.ts): porta de integridade → evidência → claim CAS →
      // confirmação por leitura → trilha obrigatória → liberação do claim.
      if (data.role_in_event !== undefined) {
        const outcome = await applyParticipantRole(svc, {
          eventId,
          participantId,
          newRole: String(data.role_in_event),
          data,
          actor: user,
          source: 'manage_participant_update',
          extraDetails: { participant_email: current.email || '' },
        });
        if (!outcome.ok) {
          return Response.json({
            error: outcome.error,
            applied: outcome.applied,
            ...(outcome.audit_state ? { audit_state: outcome.audit_state } : {}),
            ...(outcome.role_change_blocked !== undefined ? { role_change_blocked: outcome.role_change_blocked } : {}),
            ...(outcome.pending_occurrence ? { pending_occurrence: outcome.pending_occurrence } : {}),
            ...(outcome.conflict ? { conflict: outcome.conflict } : {}),
            ...(outcome.evidence_id ? { evidence_id: outcome.evidence_id } : {}),
            ...(outcome.recovery ? { recovery: outcome.recovery } : {}),
            ...(outcome.participant ? { participant: outcome.participant } : {}),
          }, { status: outcome.status });
        }
        if (outcome.unchanged) return Response.json({ participant: outcome.participant });
        return Response.json({
          participant: outcome.participant,
          audit_state: outcome.audit_state,
          evidence_id: outcome.evidence_id,
          role_change_blocked: outcome.role_change_blocked,
        });
      }

      const updated = await svc.entities.Participant.update(participantId, data);
      return Response.json({ participant: updated });
    }

    if (op === 'softDelete') {
      const participantId = String(body.participant_id || '');
      if (!participantId) return Response.json({ error: 'participant_id ausente.' }, { status: 400 });
      const found = await base44.asServiceRole.entities.Participant.filter({ id: participantId, event_id: eventId });
      if (!found.length) return Response.json({ error: 'Participante não encontrado neste evento.' }, { status: 404 });
      // Remover alguém da equipe (inclusive a si mesmo) é do gerente/admin.
      if (found[0].role_in_event === 'team' && !(await isStaffManager(base44, user, eventId))) {
        return Response.json({ error: 'Apenas o gerente do evento remove a equipe.' }, { status: 403 });
      }
      if (await speakerHasSessions(base44, eventId, participantId)) {
        return Response.json({ error: 'Não é possível remover: existe sessão associada a esta pessoa.' }, { status: 409 });
      }
      await base44.asServiceRole.entities.Participant.update(participantId, { is_deleted: true });
      return Response.json({ ok: true });
    }

    // F3-13/F3-14 (2026-11-16) — RECUPERAÇÃO da trilha de uma alteração de papel
    // JÁ EFETIVADA. A autoridade é a EVIDÊNCIA gravada ANTES da mutação; o estado
    // atual do participante, sozinho, não prova alteração nem autoria.
    // Regras:
    //   • sem evidência → nenhuma trilha é criada (409), nada é inventado;
    //   • 'started' NÃO é prova de mutação: a reconciliação exige o token de
    //     ocorrência gravado pela própria escrita (F3-15);
    //   • ocorrência posterior supera a anterior: nada é inferido do estado atual;
    //   • a leitura do AuditLog é FAIL-CLOSED: sem saber se a trilha existe, nada
    //     é gravado (F3-15);
    //   • ocorrência e chave vêm da evidência, então retry e recuperações
    //     simultâneas convergem para um único registro;
    //   • autoria = ator ORIGINAL da evidência; desconhecida → registrada como
    //     sistema/desconhecida, nunca atribuída a quem recuperou.
    // Nada do corpo (papéis, ator, evento, entidade) é autoridade.
    if (op === 'recoverRoleAudit') {
      const participantId = String(body.participant_id || '');
      if (!participantId) return Response.json({ error: 'participant_id ausente.' }, { status: 400 });
      const svc = base44.asServiceRole;

      const found = await svc.entities.Participant.filter({ id: participantId, event_id: eventId });
      if (!found.length) return Response.json({ error: 'Participante não encontrado neste evento.' }, { status: 404 });
      const current = found[0];

      // F3-16 — consulta de evidência FAIL-CLOSED: sem poder ler, não se sabe se
      // existe alteração aplicada sem trilha; nada é decidido nem gravado.
      let rows: any = null;
      try {
        rows = await svc.entities[EVIDENCE_ENTITY].filter({
          event_id: eventId,
          entity_type: 'Participant',
          entity_id: participantId,
          operation: 'role_change',
          is_deleted: false,
        });
      } catch (err: any) {
        console.error('[manageParticipant] consulta de evidência indisponível:', err?.message || err);
        return Response.json({
          error: 'Não foi possível consultar as evidências de alteração de papel (leitura indisponível). Nada foi gravado; repita a recuperação.',
          recovered: false,
          audit_state: 'unavailable',
        }, { status: 503 });
      }
      if (!Array.isArray(rows)) {
        return Response.json({
          error: 'A consulta de evidências retornou resposta não confiável. Nada foi gravado; repita a recuperação.',
          recovered: false,
          audit_state: 'unavailable',
        }, { status: 503 });
      }
      const evidences = rows;
      if (evidences.length === 0) {
        return Response.json({
          error: 'Não há evidência registrada de alteração de papel para este participante. A recuperação não cria trilha sem evidência.',
          recovered: false,
          audit_state: 'not_applicable',
        }, { status: 409 });
      }

      // `evidence_id` só seleciona; se não pertencer ao participante, recusa.
      const requestedEvidenceId = String(body.evidence_id || '');
      if (requestedEvidenceId && !evidences.some((e) => String(e.id) === requestedEvidenceId)) {
        return Response.json({
          error: 'A evidência informada não pertence a este participante. Nada foi reconstruído.',
          recovered: false,
        }, { status: 409 });
      }

      // F3-15 — SELEÇÃO da ocorrência. Com token persistido, a ocorrência é a que
      // o PRÓPRIO estado aponta; nunca "a mais recente" por horário.
      const tokenMarker = String(current[ROLE_TOKEN_FIELD] || '');
      const sorted = [...evidences].sort((a, b) => String(b.created_date || '').localeCompare(String(a.created_date || '')));
      let evidence = null;
      if (requestedEvidenceId) {
        evidence = evidences.find((e) => String(e.id) === requestedEvidenceId) || null;
      } else if (tokenMarker) {
        evidence = sorted.find((e) => String(e.occurrence || '') === tokenMarker) || null;
      } else {
        evidence = sorted.find((e) => String(e.state) !== 'audit_recorded') || sorted[0];
      }
      if (!evidence) {
        return Response.json({
          error: 'Não há evidência correspondente ao estado atual deste participante. A trilha não foi reconstruída: exige conferência manual.',
          recovered: false,
          audit_state: 'inconclusive',
          reconciliation: 'evidencia_nao_corresponde_ao_estado',
        }, { status: 409 });
      }

      // RECONCILIAÇÃO evidência × estado persistido: 'started' só entra com prova
      // de que a escrita aconteceu (token da própria ocorrência no participante).
      const reconciliation = reconcileRoleEvidence(current, evidence);
      if (!reconciliation.applied) {
        const reasons = {
          superada_por_ocorrencia_posterior:
            'Esta evidência foi superada por uma ocorrência posterior. A trilha não é inferida a partir do estado atual.',
          estado_divergente:
            'O estado persistido diverge da evidência registrada. A trilha não foi reconstruída.',
          nao_aplicada:
            'A evidência não comprova que a alteração de papel foi concluída. Nada a reconstruir; exige conferência manual.',
        };
        return Response.json({
          error: reasons[reconciliation.classification] || reasons.nao_aplicada,
          recovered: false,
          evidence_id: evidence.id,
          reconciliation: reconciliation.classification,
        }, { status: 409 });
      }

      // F3-15 — LEITURA FAIL-CLOSED da trilha. Leitura indisponível (timeout,
      // permissão, resposta inválida) NÃO é ausência de registro: sem poder
      // verificar, nada é gravado, e o retry mantém a mesma chave.
      const auditKey = String(evidence.audit_key || buildAuditKey('role_change', evidence.occurrence));
      const existingTrail = await readAuditByKey(svc, auditKey);
      if (existingTrail.state === 'unavailable') {
        return Response.json({
          error: 'Não foi possível verificar a trilha existente (leitura indisponível). Nada foi gravado; repita a recuperação.',
          recovered: false,
          audit_state: 'unavailable',
          evidence_id: evidence.id,
          reconciliation: reconciliation.classification,
        }, { status: 503 });
      }
      // Existência CONFIRMADA por leitura → apenas confirma (idempotência).
      if (existingTrail.state === 'found') {
        await markEvidence(svc, evidence.id, { state: 'audit_recorded', audit_state: 'recorded' });
        // F3-16 — a trilha existe: a porta pode voltar a permitir alteração.
        const lockReleased = await releaseRoleLock(svc, participantId, eventId, evidence.occurrence);
        return Response.json({
          ok: true,
          audit_state: 'recorded',
          recovered: false,
          already_recorded: true,
          evidence_id: evidence.id,
          reconciliation: reconciliation.classification,
          role_change_blocked: !lockReleased,
        });
      }

      // Autoria ORIGINAL — da evidência, nunca do operador da recuperação.
      const originalActorKnown = !!String(evidence.actor_user_id || '');
      const originalActor = originalActorKnown
        ? { id: String(evidence.actor_user_id), full_name: String(evidence.actor_name || ''), email: '' }
        : { id: 'system', full_name: 'Autor original desconhecido', email: '' };

      const auditState = await auditRoleChange(svc, originalActor, eventId, {
        entityId: participantId,
        occurrence: evidence.occurrence,
        details: {
          field: 'role_in_event',
          old_value: evidence.old_value === undefined ? null : evidence.old_value,
          new_value: evidence.new_value,
          participant_email: current.email || '',
          recovered: true,
          recovery_source: 'evidencia_persistida',
          evidence_id: evidence.id,
          original_actor_known: originalActorKnown,
          recovered_by_user_id: user.id,
        },
      });
      await markEvidence(svc, evidence.id, {
        state: evidenceStateFor(auditState),
        audit_state: auditState,
        failure_reason: auditState === 'unavailable' ? 'trilha indisponível na recuperação' : '',
      });

      if (auditState === 'unavailable') {
        return Response.json({
          error: 'A trilha de auditoria não pôde ser registrada. A evidência permanece preservada e a recuperação pode ser repetida.',
          audit_state: 'unavailable',
          recovered: false,
          evidence_id: evidence.id,
          reconciliation: reconciliation.classification,
        }, { status: 503 });
      }

      // F3-16 — trilha gravada (ou pendência persistida): só a gravação CONFIRMADA
      // libera a porta para uma nova alteração de papel deste participante.
      const lockReleased = auditState === 'recorded'
        ? await releaseRoleLock(svc, participantId, eventId, evidence.occurrence)
        : false;

      return Response.json({
        ok: true,
        audit_state: auditState,
        recovered: true,
        already_recorded: false,
        evidence_id: evidence.id,
        original_actor_known: originalActorKnown,
        reconciliation: reconciliation.classification,
        role_change_blocked: !lockReleased,
      });
    }

    if (op === 'getSessions') {
      const sessions = await base44.asServiceRole.entities.Session.filter({ event_id: eventId, is_deleted: false });
      return Response.json({ sessions: sessions.map((s) => ({ id: s.id, title: s.title, speaker_id: s.speaker_id })) });
    }

    if (op === 'getReviewers') {
      const memberships = await base44.asServiceRole.entities.EventMembership.filter({
        event_id: eventId,
        role: 'reviewer',
        is_active: true,
        is_deleted: false,
      });
      return Response.json({ reviewers: memberships });
    }

    if (op === 'getReviewer') {
      const personId = String(body.person_id || '');
      if (!personId) return Response.json({ error: 'person_id ausente.' }, { status: 400 });
      const memberships = await base44.asServiceRole.entities.EventMembership.filter({
        event_id: eventId,
        person_id: personId,
        role: 'reviewer',
        is_deleted: false,
      });
      const membership = memberships[0] || null;
      const linkedUserId = (membership?.user_id) || (membership ? await resolveUserIdByEmail(base44, membership.user_email) : '');
      return Response.json({ membership, linked_user_id: linkedUserId });
    }

    if (op === 'setReviewer') {
      // Curador/avaliador: só admin ou o GERENTE concede/revoga (equipe não).
      if (!(await isStaffManager(base44, user, eventId))) {
        return Response.json({ error: 'Apenas o gerente do evento designa avaliadores.' }, { status: 403 });
      }
      const personId = String(body.person_id || '');
      const enable = body.enable === true;
      const membershipId = String(body.membership_id || '');

      // A-05 (2026-11-06): porta única com manageEventRole. Antes esta rota
      // criava o vínculo ATIVO mesmo sem conta (acesso vazio) e não limpava a
      // banca na revogação. Agora: sem conta = convite pendente; revogar aqui
      // também tira a pessoa das premiações.
      if (!enable) {
        if (!membershipId) return Response.json({ error: 'membership_id ausente para desativar avaliador.' }, { status: 400 });
        try {
          const revoked: any = await revokeEventRole(base44, { eventId, role: 'reviewer', membershipId, actor: user });
          return Response.json({ ok: true, audit_state: revoked?.auditState });
        } catch (error: any) {
          if (error?.message === 'not_found') {
            return Response.json({ error: 'Vínculo de avaliador não encontrado neste evento.' }, { status: 404 });
          }
          throw error;
        }
      }

      // F3-15 — na REATIVAÇÃO o person_id do corpo é opcional (só confere
      // titularidade); a concessão continua exigindo pessoa.
      if (!personId && !membershipId) return Response.json({ error: 'person_id ausente.' }, { status: 400 });

      // Resolução por e-mail pertence apenas à CONCESSÃO. A reativação usa a
      // identidade persistida do vínculo e não aceita e-mail do corpo.
      let email = '';
      if (!membershipId) {
        email = normalizeParticipantEmail(body.user_email || '');
        if (!email) {
          const persons = await base44.asServiceRole.entities.Person.filter({ id: personId });
          email = normalizeParticipantEmail(persons?.[0]?.contact_email || '');
        }
        if (!email) {
          const parts = await base44.asServiceRole.entities.Participant.filter({ event_id: eventId, person_id: personId, is_deleted: false });
          email = normalizeParticipantEmail(parts?.[0]?.email || '');
        }
        if (!email) {
          return Response.json({ error: 'Informe o e-mail da pessoa para designá-la avaliadora.' }, { status: 400 });
        }
      }

      // Vínculo já existente (mesmo desativado): reativa em vez de duplicar.
      // F3-14 — a REATIVAÇÃO passa pelo mecanismo CENTRAL de auditoria de acesso
      // (recordAccessChange). Antes ela devolvia is_deleted:false/is_active:true
      // e concedia acesso de avaliador sem qualquer trilha.
      if (membershipId) {
        const svc = base44.asServiceRole;
        const rows = await svc.entities.EventMembership.filter({ id: membershipId });
        const membership = rows?.[0];
        // Escopo e papel conferidos no servidor: vínculo de outro evento (ou de
        // outro papel) não é reativado por esta rota.
        if (!membership || String(membership.event_id) !== eventId || String(membership.role) !== 'reviewer') {
          return Response.json({ error: 'Vínculo de avaliador não encontrado neste evento.' }, { status: 404 });
        }
        // Estado contraditório (ativo e excluído ao mesmo tempo): não reativa no
        // escuro — a concessão precisa passar de novo pelo fluxo de convite.
        if (membership.is_active === true && membership.is_deleted === true) {
          return Response.json({
            error: 'Este vínculo de avaliador está em estado inconsistente. Conceda o acesso novamente pelo fluxo de convite.',
          }, { status: 409 });
        }
        // O corpo NÃO substitui a identidade do vínculo: person_id divergente é
        // recusado (não é o titular deste vínculo).
        const bodyPersonId = String(body.person_id || '');
        if (bodyPersonId && bodyPersonId !== String(membership.person_id || '')) {
          return Response.json({
            error: 'A pessoa informada não é a titular deste vínculo de avaliador.',
            status: 'identity_mismatch',
            reason: 'person_id_mismatch',
          }, { status: 409 });
        }

        const alreadyActive = membership.is_active === true && membership.is_deleted === false;
        // F3-15 — TITULARIDADE derivada EXCLUSIVAMENTE de registros do servidor.
        // Antes: `membership.user_email || email`, e `email` podia vir do corpo.
        // Agora: person_id do vínculo → Person → conta confirmada da pessoa;
        // a conta vinculada precisa pertencer à pessoa. Sem identidade suficiente
        // a reativação é recusada e um novo fluxo de convite é exigido.
        const holder = await resolveMembershipHolder(base44, membership);
        if (!holder.ok) {
          return Response.json({
            error: holder.message,
            status: 'identity_unresolved',
            reason: holder.reason,
          }, { status: 409 });
        }
        const targetEmail = holder.email;
        const userId = holder.user_id;

        let saved = membership;
        if (!alreadyActive) {
          saved = await svc.entities.EventMembership.update(membershipId, {
            is_deleted: false,
            is_active: true,
            user_id: userId,
            user_email: targetEmail,
          });
        }

        // Chave determinística = (evento, vínculo, versão do vínculo). Repetir a
        // reativação (já ativo) recalcula a MESMA chave, então nem retry nem
        // repetição duplicam a trilha — e um retry após falha de auditoria a
        // recupera em vez de deixá-la silenciosa.
        const auditState = await recordAccessChange(svc, {
          eventId,
          entityType: 'EventMembership',
          entityId: membershipId,
          actor: user,
          operation: 'reviewer_reactivation',
          reference: `${eventId}:${membershipId}:${saved?.updated_date || membership.updated_date || ''}`,
          details: {
            role: 'reviewer',
            outcome: alreadyActive ? 'already_active' : 'reactivated',
            reviewer_user_id: userId,
            reviewer_email: targetEmail,
            person_id: membership.person_id || personId,
            // F3-16 — vínculo comprovado User↔Person e divergência de snapshot.
            person_link_confirmed: holder.person_link,
            snapshot_email_mismatch: !!holder.snapshot_email_mismatch,
          },
        });

        if (auditState === 'unavailable') {
          return Response.json({
            error: 'Acesso de avaliador ativo, mas a trilha de auditoria não pôde ser registrada. Repita a operação para concluir a auditoria.',
            status: userId ? 'linked' : 'invited',
            audit_state: auditState,
            already_active: alreadyActive,
            recovery: { op: 'setReviewer', event_id: eventId, membership_id: membershipId, enable: true, person_id: personId },
          }, { status: 503 });
        }
        return Response.json({
          ok: true,
          status: userId ? 'linked' : 'invited',
          audit_state: auditState,
          already_active: alreadyActive,
        });
      }

      try {
        const result: any = await grantEventRole(base44, {
          eventId,
          email,
          displayName: String(body.person_name || ''),
          role: 'reviewer',
          actor: user,
        });
        // F3-13 — a concessão é auditada em grantEventRole; o estado da trilha
        // acompanha a resposta (recorded | pending | unavailable).
        return Response.json({ ok: true, status: result.status, audit_state: result.auditState });
      } catch (error: any) {
        const map: Record<string, string> = {
          event_not_found: 'Evento não encontrado.',
          account_deleted: 'Esta conta foi excluída e não pode receber acesso.',
          identity_ambiguous: 'Há mais de um cadastro de pessoa com este e-mail. Consolide o cadastro antes.',
        };
        const mapped = map[error?.message];
        if (mapped) return Response.json({ error: mapped }, { status: 409 });
        throw error;
      }
    }

    if (op === 'findPersonsByDocument') {
      const digits = normDigits(body.digits);
      if (digits.length < 3) return Response.json({ person_ids: [] });
      // P1 (auditoria 2026-09-28) — escopo do PRÓPRIO evento (padrão INF-002):
      // antes carregava TODOS os documentos ativos do sistema (full scan global
      // + substring = PERF-002 real) e devolvia person_ids de pessoas de
      // QUALQUER evento — vazamento cross-event de PII para gerentes. Agora a
      // busca cobre apenas as Persons vinculadas a participantes deste evento,
      // com $in fatiado por 500 (sem scan global).
      const parts = await base44.asServiceRole.entities.Participant.filter({
        event_id: eventId,
        is_deleted: false,
      });
      const personIds = [...new Set(parts.map((p) => p.person_id).filter(Boolean))];
      if (personIds.length === 0) return Response.json({ person_ids: [] });
      const matched = new Set();
      for (let i = 0; i < personIds.length; i += 500) {
        const chunk = personIds.slice(i, i + 500);
        const docs = await base44.asServiceRole.entities.PersonDocument.filter({
          person_id: { $in: chunk },
          status: 'active',
        });
        for (const d of docs) {
          if (normDigits(d.document_number).includes(digits)) matched.add(d.person_id);
        }
      }
      return Response.json({ person_ids: [...matched].slice(0, 100) });
    }

    if (op === 'importCreate') {
      const fileName = String(body.file_name || '').slice(0, 200);
      if (!fileName) return Response.json({ error: 'file_name ausente.' }, { status: 400 });
      const record = await base44.asServiceRole.entities.Import.create({
        event_id: eventId,
        file_name: fileName,
        status: 'processing',
        total_rows: Number(body.total_rows) || 0,
      });
      return Response.json({ import: record });
    }

    if (op === 'importUpdate') {
      const importId = String(body.import_id || '');
      if (!importId) return Response.json({ error: 'import_id ausente.' }, { status: 400 });
      const found = await base44.asServiceRole.entities.Import.filter({ id: importId, event_id: eventId });
      if (!found.length) return Response.json({ error: 'Importação não encontrada.' }, { status: 404 });
      const src = body.data || {};
      const data = {};
      for (const key of ['status', 'success_count', 'error_count', 'duplicate_count', 'errors_detail']) {
        if (key in src) data[key] = src[key];
      }
      // P3 — envia apenas as chaves presentes em src: passar chaves ausentes
      // explicitamente podia limpar contadores/status em updates parciais.
      await base44.asServiceRole.entities.Import.update(importId, data);
      return Response.json({ ok: true });
    }

    // ── EQUIPE DO EVENTO (2026-11-04) ───────────────────────────────────────
    // Staff precisa de conta (User) + Person. Sem conta → convite por e-mail e
    // vínculo pendente, concluído no primeiro acesso (linkPendingInvites).
    if (op === 'listStaff') {
      if (!(await isStaffManager(base44, user, eventId))) {
        return Response.json({ error: 'Apenas o gerente do evento gerencia a equipe.' }, { status: 403 });
      }
      const svc = base44.asServiceRole;
      const [memberships, invites, participants] = await Promise.all([
        svc.entities.EventMembership.filter({ event_id: eventId, role: 'team', is_active: true, is_deleted: false }),
        svc.entities.EventInvite.filter({ event_id: eventId, target_role: 'team', status: 'pending', is_deleted: false }),
        svc.entities.Participant.filter({ event_id: eventId, role_in_event: 'team', is_deleted: false }),
      ]);
      return Response.json({ memberships, invites, participants });
    }

    if (op === 'assignStaff') {
      if (!(await isStaffManager(base44, user, eventId))) {
        return Response.json({ error: 'Apenas o gerente do evento cadastra a equipe.' }, { status: 403 });
      }
      const email = normalizeParticipantEmail(body.email || body.data?.email || '');
      const displayName = String(body.full_name || body.data?.full_name || '').slice(0, 120);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return Response.json({ error: 'Informe um e-mail válido.' }, { status: 400 });
      }
      try {
        const result: any = await grantEventRole(base44, {
          eventId,
          email,
          displayName,
          role: 'team',
          actor: user,
        });
        if (result.status === 'linked') {
          const auditState = await auditRoleChange(base44.asServiceRole, user, eventId, {
            entityType: 'EventMembership',
            entityId: result.membership?.id || '',
            occurrence: `membership:${result.membership?.id || ''}`,
            details: { role: 'team', granted_to: email, outcome: 'linked' },
          });
          if (auditState === 'unavailable') {
            return Response.json({
              error: 'Equipe vinculada, mas a trilha de auditoria não pôde ser registrada. Repita a operação para concluir a auditoria.',
              membership: result.membership,
              audit_state: 'unavailable',
            }, { status: 503 });
          }
          return Response.json({ status: 'linked', membership: result.membership, audit_state: auditState });
        }
        const auditState = await auditRoleChange(base44.asServiceRole, user, eventId, {
          entityType: 'EventMembership',
          entityId: '',
          occurrence: `invite:${eventId}:${email}`,
          details: { role: 'team', granted_to: email, outcome: 'invited' },
        });
        if (auditState === 'unavailable') {
          return Response.json({
            error: 'Convite registrado, mas a trilha de auditoria não pôde ser registrada. Repita a operação para concluir a auditoria.',
            audit_state: 'unavailable',
          }, { status: 503 });
        }
        return Response.json({
          status: 'invited',
          invite: { invited: !!result.invited, error: result.inviteError || '' },
          audit_state: auditState,
        });
      } catch (error: any) {
        const map: Record<string, [string, number]> = {
          event_not_found: ['Evento não encontrado.', 404],
          account_deleted: ['Esta conta foi excluída e não pode receber acesso.', 409],
          identity_ambiguous: ['Há mais de um cadastro de pessoa com este e-mail. Consolide o cadastro antes.', 409],
        };
        const mapped = map[error?.message];
        if (mapped) return Response.json({ error: mapped[0] }, { status: mapped[1] });
        throw error;
      }
    }

    if (op === 'removeStaff') {
      if (!(await isStaffManager(base44, user, eventId))) {
        return Response.json({ error: 'Apenas o gerente do evento remove a equipe.' }, { status: 403 });
      }
      const participantId = String(body.participant_id || '');
      const svc = base44.asServiceRole;
      const parts = participantId
        ? await svc.entities.Participant.filter({ id: participantId, event_id: eventId })
        : [];
      const participant = parts?.[0] || null;
      const email = normalizeParticipantEmail(body.email || participant?.email || '');
      if (!participant && !email) {
        return Response.json({ error: 'Informe quem deve sair da equipe.' }, { status: 400 });
      }

      // P1-04 (AUD-03) — sair da equipe REBAIXA o papel: passa pela primitiva
      // única (porta de integridade + evidência + claim + trilha). Roda ANTES de
      // desativar vínculos para não deixar estado pela metade.
      if (participant && participant.role_in_event === 'team') {
        const demote = await applyParticipantRole(svc, {
          eventId,
          participantId: participant.id,
          newRole: 'attendee',
          actor: user,
          source: 'remove_staff',
          extraDetails: { participant_email: email || participant.email || '' },
        });
        if (!demote.ok) {
          return Response.json({
            error: demote.error,
            applied: demote.applied,
            ...(demote.audit_state ? { audit_state: demote.audit_state } : {}),
            role_change_blocked: demote.role_change_blocked !== false,
            ...(demote.pending_occurrence ? { pending_occurrence: demote.pending_occurrence } : {}),
            ...(demote.recovery ? { recovery: demote.recovery } : {}),
          }, { status: demote.status });
        }
      }

      const memberships = await svc.entities.EventMembership.filter({
        event_id: eventId,
        role: 'team',
        is_deleted: false,
        ...(participant?.person_id ? { person_id: participant.person_id } : { user_email: email }),
      });
      for (const m of memberships || []) {
        await svc.entities.EventMembership.update(m.id, { is_active: false, is_deleted: true });
      }
      // Remover da equipe não apaga a presença (o rebaixamento já foi feito pela
      // primitiva acima).
      const auditState = await auditRoleChange(svc, user, eventId, {
        entityType: 'EventMembership',
        entityId: memberships?.[0]?.id || '',
        occurrence: `removal:${eventId}:${email || participant?.id || ''}`,
        details: {
          role: 'team',
          removed: (memberships || []).length,
          participant_id: participant?.id || '',
          participant_email: email || '',
        },
      });
      if (auditState === 'unavailable') {
        return Response.json({
          error: 'Equipe removida, mas a trilha de auditoria não pôde ser registrada. Repita a operação para concluir a auditoria.',
          memberships_removed: (memberships || []).length,
          audit_state: 'unavailable',
        }, { status: 503 });
      }
      return Response.json({ ok: true, memberships_removed: (memberships || []).length, audit_state: auditState });
    }

    return Response.json({ error: 'Operação desconhecida: ' + op }, { status: 400 });
  } catch (error) {
    console.error('manageParticipant error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}