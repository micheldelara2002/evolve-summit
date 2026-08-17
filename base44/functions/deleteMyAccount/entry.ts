import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// Account Deletion — self-service exclusão de conta do próprio usuário.
//
// Princípio: excluir/anonimizar a IDENTIDADE, preservar o HISTÓRICO do evento.
//
// O Base44 NÃO expõe hard-delete do User de autenticação via SDK/service-role.
// Portanto o registro de autenticação (User) permanece, mas é marcado como
// account_status='deleted' (bloqueia acesso via guard no AuthContext) e tem
// sua PII (photo_url, full_name best-effort) removida.
//
// Autorização: o alvo é derivado de base44.auth.me() — NUNCA de um user_id
// enviado pelo cliente. O usuário só pode excluir a própria conta.
//
// Idempotência: se account_status==='deleted', retorna { alreadyDeleted: true }
// sem re-executar operações destrutivas.
//
// dryRun (default false): executa todas as leituras e retorna contagens sem
// aplicar nenhuma escrita. Útil para validação segura do fluxo de lookup.
//
// Paginação: skip + limit (BATCH=500), sort '-id' — mesmo padrão validado em
// reconcileParticipantCounters. Memória O(batch) em todos os caminhos.
//
// Preservado (intocado): PointTransaction, StoreRedemption, SessionReview,
// SessionQuestion, Certificate, PartnerRepresentative, MetricBucket,
// EventStats, Event, e demais entidades não relacionadas à identidade.
// Nenhuma reconciliação de métricas é executada — anonimizar PII não altera
// somas de pontos, contadores ou ranking.

const BATCH = 500;
const DELETED_NAME = "Usuário Excluído";
// Participant.email é `required` (string) no schema — null é rejeitado pela
// validação. Usamos um marcador constante, NÃO derivado do email original,
// claramente não identificável (não é email válido, não é PII).
const DELETED_EMAIL_MARKER = "conta_excluida";

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const svc = base44.asServiceRole;

    // Idempotência: conta já excluída — não re-executa.
    if (user.account_status === 'deleted') {
      return Response.json({ ok: true, alreadyDeleted: true });
    }

    const body = await req.json().catch(() => ({}));
    const dryRun = !!body.dryRun;

    const personId = user.person_id || null;
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
    };

    // =========================================================================
    // 1. PERSON (por id) — limpa toda PII, mantém id + relacionamentos
    // =========================================================================
    if (personId) {
      const [person] = await svc.entities.Person.filter({ id: personId });
      if (person) {
        counts.person = 1;
        if (!dryRun) {
          await svc.entities.Person.update(personId, {
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
    }

    // =========================================================================
    // 2. PARTICIPANT (por person_id, depois por email) — preserva id + event_id
    // =========================================================================
    const participantIds = new Set();
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
    });

    const pageParticipants = async (query) => {
      let skip = 0;
      while (true) {
        const batch = await svc.entities.Participant.filter(query, '-id', BATCH, skip);
        if (batch.length === 0) break;
        const updates = [];
        for (const p of batch) {
          if (participantIds.has(p.id)) continue;
          participantIds.add(p.id);
          updates.push(participantAnon(p.id));
          counts.participants++;
        }
        if (!dryRun && updates.length > 0) {
          await svc.entities.Participant.bulkUpdate(updates);
        }
        skip += BATCH;
        if (batch.length < BATCH) break;
      }
    };

    if (personId) await pageParticipants({ person_id: personId });
    if (user.email) await pageParticipants({ email: user.email });

    // =========================================================================
    // 3. LEAD (por person_id, depois por participant_id $in) — preserva partner
    // =========================================================================
    const leadIds = new Set();
    const leadAnon = (id) => ({
      id,
      participant_name: DELETED_NAME,
      participant_email: null,
      person_phone: null,
      person_linkedin: null,
      person_company: null,
      person_job_title: null,
    });

    if (personId) {
      let skip = 0;
      while (true) {
        const batch = await svc.entities.Lead.filter({ person_id: personId }, '-id', BATCH, skip);
        if (batch.length === 0) break;
        const updates = [];
        for (const l of batch) {
          if (leadIds.has(l.id)) continue;
          leadIds.add(l.id);
          updates.push(leadAnon(l.id));
          counts.leads++;
        }
        if (!dryRun && updates.length > 0) await svc.entities.Lead.bulkUpdate(updates);
        skip += BATCH;
        if (batch.length < BATCH) break;
      }
    }
    const partIdArr = Array.from(participantIds);
    for (let i = 0; i < partIdArr.length; i += BATCH) {
      const chunk = partIdArr.slice(i, i + BATCH);
      let skip = 0;
      while (true) {
        const batch = await svc.entities.Lead.filter(
          { participant_id: { $in: chunk } }, '-id', BATCH, skip
        );
        if (batch.length === 0) break;
        const updates = [];
        for (const l of batch) {
          if (leadIds.has(l.id)) continue;
          leadIds.add(l.id);
          updates.push(leadAnon(l.id));
          counts.leads++;
        }
        if (!dryRun && updates.length > 0) await svc.entities.Lead.bulkUpdate(updates);
        skip += BATCH;
        if (batch.length < BATCH) break;
      }
    }

    // =========================================================================
    // 4. CHATMESSAGE (por sender_person_id) — preserva texto, anonimiza nome
    // =========================================================================
    if (personId) {
      let skip = 0;
      while (true) {
        const batch = await svc.entities.ChatMessage.filter(
          { sender_person_id: personId }, '-id', BATCH, skip
        );
        if (batch.length === 0) break;
        if (!dryRun) {
          await svc.entities.ChatMessage.bulkUpdate(
            batch.map((m) => ({ id: m.id, sender_name: DELETED_NAME }))
          );
        }
        counts.chatMessages += batch.length;
        skip += BATCH;
        if (batch.length < BATCH) break;
      }
    }

    // =========================================================================
    // 5. CHATTHREAD (person_a ou person_b) — anonimiza snapshot de nome do lado
    // =========================================================================
    if (personId) {
      for (const side of ['person_a_id', 'person_b_id']) {
        const nameField = side === 'person_a_id' ? 'person_a_name' : 'person_b_name';
        let skip = 0;
        while (true) {
          const batch = await svc.entities.ChatThread.filter({ [side]: personId }, '-id', BATCH, skip);
          if (batch.length === 0) break;
          if (!dryRun) {
            await svc.entities.ChatThread.bulkUpdate(
              batch.map((t) => ({ id: t.id, [nameField]: DELETED_NAME }))
            );
          }
          counts.chatThreads += batch.length;
          skip += BATCH;
          if (batch.length < BATCH) break;
        }
      }
    }

    // =========================================================================
    // 6. CONNECTION (person_a ou person_b) — anonimiza snapshot de nome
    // =========================================================================
    if (personId) {
      for (const side of ['person_a_id', 'person_b_id']) {
        const nameField = side === 'person_a_id' ? 'person_a_name' : 'person_b_name';
        let skip = 0;
        while (true) {
          const batch = await svc.entities.Connection.filter({ [side]: personId }, '-id', BATCH, skip);
          if (batch.length === 0) break;
          if (!dryRun) {
            await svc.entities.Connection.bulkUpdate(
              batch.map((c) => ({ id: c.id, [nameField]: DELETED_NAME }))
            );
          }
          counts.connections += batch.length;
          skip += BATCH;
          if (batch.length < BATCH) break;
        }
      }
    }

    // =========================================================================
    // 7. CONNECTIONREQUEST (requester ou receiver) — anonimiza snapshot de nome
    // =========================================================================
    if (personId) {
      for (const side of ['requester_person_id', 'receiver_person_id']) {
        const nameField = side === 'requester_person_id' ? 'requester_name' : 'receiver_name';
        let skip = 0;
        while (true) {
          const batch = await svc.entities.ConnectionRequest.filter(
            { [side]: personId }, '-id', BATCH, skip
          );
          if (batch.length === 0) break;
          if (!dryRun) {
            await svc.entities.ConnectionRequest.bulkUpdate(
              batch.map((c) => ({ id: c.id, [nameField]: DELETED_NAME }))
            );
          }
          counts.connectionRequests += batch.length;
          skip += BATCH;
          if (batch.length < BATCH) break;
        }
      }
    }

    // =========================================================================
    // 8. EVENTMEMBERSHIP (por person_id e por user_id) — anonimiza nome/email
    // =========================================================================
    const membershipIds = new Set();
    const membershipAnon = (id) => ({
      id,
      person_name: DELETED_NAME,
      user_email: null,
    });
    for (const queryKey of [
      personId ? { person_id: personId } : null,
      { user_id: user.id },
    ]) {
      if (!queryKey) continue;
      let skip = 0;
      while (true) {
        const batch = await svc.entities.EventMembership.filter(queryKey, '-id', BATCH, skip);
        if (batch.length === 0) break;
        const updates = [];
        for (const m of batch) {
          if (membershipIds.has(m.id)) continue;
          membershipIds.add(m.id);
          updates.push(membershipAnon(m.id));
          counts.memberships++;
        }
        if (!dryRun && updates.length > 0) await svc.entities.EventMembership.bulkUpdate(updates);
        skip += BATCH;
        if (batch.length < BATCH) break;
      }
    }

    // =========================================================================
    // 9. NOTIFICATIONRECIPIENT (por recipient_user_id) — preserva métricas
    // =========================================================================
    {
      let skip = 0;
      while (true) {
        const batch = await svc.entities.NotificationRecipient.filter(
          { recipient_user_id: user.id }, '-id', BATCH, skip
        );
        if (batch.length === 0) break;
        if (!dryRun) {
          await svc.entities.NotificationRecipient.bulkUpdate(
            batch.map((r) => ({
              id: r.id,
              recipient_name: DELETED_NAME,
              recipient_email: null,
            }))
          );
        }
        counts.recipients += batch.length;
        skip += BATCH;
        if (batch.length < BATCH) break;
      }
    }

    // =========================================================================
    // 10. AUDITLOG — registra a operação SEM PII
    // =========================================================================
    if (!dryRun) {
      await svc.entities.AuditLog.create({
        event_id: "",
        action: "account_deletion",
        entity_type: "User",
        entity_id: user.id,
        user_id: user.id,
        user_name: DELETED_NAME,
        details: JSON.stringify({ counts }),
        ip_address: "",
      });
    }

    // =========================================================================
    // 11. USER — marca conta como deleted (ÚLTIMO, gates acesso) + limpa PII
    // =========================================================================
    if (!dryRun) {
      await svc.entities.User.update(user.id, {
        account_status: 'deleted',
        photo_url: null,
      });
      // Best-effort: limpa o nome de exibição da autenticação. Campos built-in
      // podem rejeitar a sobrescrita; não falha o fluxo — account_status já
      // bloqueia o acesso (guard no AuthContext).
      try {
        await svc.entities.User.update(user.id, { full_name: DELETED_NAME });
      } catch (_) { /* best-effort — campo built-in pode ser imutável */ }
    }

    return Response.json({ ok: true, dryRun, personId, counts });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}