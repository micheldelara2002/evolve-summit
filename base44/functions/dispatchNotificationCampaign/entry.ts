// =============================================================================
// P0 NotificationCampaign — Batched dispatch with state machine
// =============================================================================
//
// GARANTIA DE ENTREGA: "at-least-once processing/attempt semantics, with
// possible duplicate delivery."
//
// Diferenciação formal:
//   - Tentativa de processamento: execução da função (worker run).
//   - Aceite pelo provider: bulkUpdate delivery_status="sent" (a "entrega"
//     in-app é o registro ficar visível no inbox do destinatário).
//   - Entrega efetiva ao usuário: notificação exibida no NotificationInbox
//     (fora do controle do Base44).
//
// STATE MACHINE (NotificationRecipient.delivery_status):
//   pending → processing → sent   (sucesso)
//   pending → processing → failed  (erro)
//
//   - Recipient é criado como "pending" na fase de resolução.
//   - Antes do envio, marcado como "processing" (sinal visível de work-in-progress).
//   - Após sucesso do "envio" (bulkUpdate), marcado como "sent" com delivered_at.
//   - Em erro, marcado como "failed" com error_reason.
//   - "sent" é terminal: NUNCA reprocessado.
//   - Retry processa pending, processing (stuck por crash) e failed.
//
// CONCORRÊNCIA — LIMITAÇÕES EXPLÍCITAS (sem CAS/UNIQUE/lock atômico no Base44):
//
//   1. campaign.status = "processing" NÃO é um lock.
//      Interleaving: A lê "pending" → B lê "pending" → A grava "processing" →
//      B grava "processing" → ambos processam.
//      status é apenas um guard lógico de aplicação (impede reenvio via UI,
//      não impede concorrência entre workers).
//
//   2. NÃO existe claim/lock atômico de batch.
//      Dois workers podem ler o mesmo batch de recipients e ambos processar.
//      Risco residual: duplicate-send (ambos marcam como "sent").
//
//   3. idempotency_key (campaignId:userId) é apenas identificação lógica.
//      Sem UNIQUE constraint, dois workers podem ambos criar recipients
//      para o mesmo userId (race condition filter→create→filter→create).
//      A deduplicação via $in query reduz drasticamente a probabilidade
//      mas NÃO é uma garantia atômica.
//
//   4. Retry seguro: recipients "sent" são terminais e nunca reprocessados.
//      Retry reprocessa apenas pending, processing e failed.
//
// PERFORMANCE — O(batch) memory:
//   - Audiência resolvida em batches de 500 (paginação por skip/limit).
//   - Sem User.list() global.
//   - Sem array global de recipients.
//   - Deduplicação por batch via $in query (1 query por batch, não N queries).
//   - Set local de recipients apenas por batch (O(500)).
//
// NOTA: O Set de emails de Participants (audiência "all") é O(P) onde P =
// participantes do evento. Isto é um requisito de business logic (dedup de
// email entre Participants), não um Set global de recipients. É necessário
// para preservar a regra de audiência exata do código original.
// =============================================================================

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { verifyEventMembership, verifyAnyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

const BATCH_SIZE = 500;

type Recipient = { user_id: string; name: string; email: string; role: string };

// =============================================================================
// Async Generator: Resolve audience in batches of up to BATCH_SIZE.
// Yields Recipient[] arrays. Within-batch dedup by user_id is applied.
// Cross-batch dedup is handled by the caller via $in query.
// =============================================================================
async function* resolveAudienceBatches(
  svc: any,
  params: {
    scopeType: string;
    scopeEventId: string | null;
    audienceType: string;
    audienceSegments: string[];
    senderUser: any;
    senderPartnerId: string | null;
  }
): AsyncGenerator<Recipient[]> {
  const { scopeType, scopeEventId, audienceType, audienceSegments = [], senderUser, senderPartnerId } = params;

  const isAll = audienceType === "all" || (audienceType === "segment" && audienceSegments.includes("all"));

  if (isAll) {
    // --- All Users (paginated, O(batch) memory) ---
    let skip = 0;
    while (true) {
      const users = await svc.entities.User.filter({}, "id", BATCH_SIZE, skip);
      if (users.length === 0) break;
      yield users.map((u: any) => ({
        user_id: u.id, name: u.full_name || "", email: u.email || "", role: u.role || "",
      }));
      skip += BATCH_SIZE;
      if (users.length < BATCH_SIZE) break;
    }

    // --- All Participants of the event (paginated, email dedup) ---
    if (scopeEventId) {
      skip = 0;
      // Cross-batch email dedup Set — O(P) where P = event participants.
      // Business logic requirement: preserves exact same recipient selection
      // as original code (dedup Participants by email within "all" audience).
      const emailSeen = new Set<string>();
      while (true) {
        const parts = await svc.entities.Participant.filter(
          { event_id: scopeEventId, is_deleted: false }, "id", BATCH_SIZE, skip
        );
        if (parts.length === 0) break;
        const batch: Recipient[] = [];
        for (const p of parts) {
          const key = p.email?.toLowerCase();
          if (!key || emailSeen.has(key)) continue;
          emailSeen.add(key);
          batch.push({
            user_id: p.id, name: p.full_name || "", email: p.email || "",
            role: p.role_in_event || "attendee",
          });
        }
        if (batch.length > 0) yield batch;
        skip += BATCH_SIZE;
        if (parts.length < BATCH_SIZE) break;
      }
    }
  } else if (audienceType === "segment") {
    // --- Segment: collect User-role filters for single scan ---
    const userRoleMap: Record<string, string> = {};
    for (const seg of audienceSegments) {
      if (seg === "admin") userRoleMap["admin"] = "admin";
      if (seg === "gerente") { userRoleMap["gerente"] = "gerente"; userRoleMap["manager"] = "gerente"; }
      if (seg === "attendee" && !scopeEventId) userRoleMap["user"] = "user";
    }

    const userRoles = Object.keys(userRoleMap);
    if (userRoles.length > 0) {
      let skip = 0;
      while (true) {
        const users = await svc.entities.User.filter({}, "id", BATCH_SIZE, skip);
        if (users.length === 0) break;
        const batch: Recipient[] = users
          .filter((u: any) => userRoles.includes(u.role))
          .map((u: any) => ({
            user_id: u.id, name: u.full_name || "", email: u.email || "",
            role: userRoleMap[u.role] || u.role || "",
          }));
        if (batch.length > 0) yield batch;
        skip += BATCH_SIZE;
        if (users.length < BATCH_SIZE) break;
      }
    }

    // --- Participant-based segments (paginated per role) ---
    const participantSegMap: Record<string, string> = {
      gerente: "manager",
      staff: "team",
      palestrante: "speaker",
      representante: "partner_rep",
      attendee: "attendee",
    };
    const roleLabels: Record<string, string> = {
      gerente: "manager",
      staff: "team",
      palestrante: "speaker",
      representante: "representante",
      attendee: "attendee",
    };

    for (const seg of audienceSegments) {
      if (!participantSegMap[seg]) continue;
      if (!scopeEventId) continue; // attendee without event handled by Users above
      const roleInEvent = participantSegMap[seg];
      const roleLabel = roleLabels[seg];
      let skip = 0;
      while (true) {
        const parts = await svc.entities.Participant.filter(
          { event_id: scopeEventId, role_in_event: roleInEvent, is_deleted: false },
          "id", BATCH_SIZE, skip
        );
        if (parts.length === 0) break;
        yield parts.map((p: any) => ({
          user_id: p.id, name: p.full_name || "", email: p.email || "", role: roleLabel,
        }));
        skip += BATCH_SIZE;
        if (parts.length < BATCH_SIZE) break;
      }
    }
  } else if (audienceType === "my_leads" && senderUser && senderPartnerId && scopeEventId) {
    let skip = 0;
    while (true) {
      const leads = await svc.entities.Lead.filter(
        { event_id: scopeEventId, partner_id: senderPartnerId },
        "id", BATCH_SIZE, skip
      );
      if (leads.length === 0) break;
      yield leads.map((l: any) => ({
        user_id: l.participant_id, name: l.participant_name || "",
        email: l.participant_email || "", role: "attendee",
      }));
      skip += BATCH_SIZE;
      if (leads.length < BATCH_SIZE) break;
    }
  } else if (audienceType === "partner_all_event" && scopeEventId) {
    let skip = 0;
    while (true) {
      const parts = await svc.entities.Participant.filter(
        { event_id: scopeEventId, is_deleted: false }, "id", BATCH_SIZE, skip
      );
      if (parts.length === 0) break;
      yield parts.map((p: any) => ({
        user_id: p.id, name: p.full_name || "", email: p.email || "",
        role: p.role_in_event || "attendee",
      }));
      skip += BATCH_SIZE;
      if (parts.length < BATCH_SIZE) break;
    }
  } else if (audienceType === "partner_leads" && scopeEventId && senderPartnerId) {
    let skip = 0;
    while (true) {
      const leads = await svc.entities.Lead.filter(
        { event_id: scopeEventId, partner_id: senderPartnerId },
        "id", BATCH_SIZE, skip
      );
      if (leads.length === 0) break;
      yield leads.map((l: any) => ({
        user_id: l.participant_id, name: l.participant_name || "",
        email: l.participant_email || "", role: "attendee",
      }));
      skip += BATCH_SIZE;
      if (leads.length < BATCH_SIZE) break;
    }
  } else if (audienceType === "my_attendees" && senderUser && scopeEventId) {
    // Complex resolution: speaker → sessions → attendance → participants
    const persons = await svc.entities.Person.filter({ contact_email: senderUser.email, is_active: true });
    const speakerPerson = persons?.[0];
    if (speakerPerson) {
      const speakerParts = await svc.entities.Participant.filter({
        event_id: scopeEventId, person_id: speakerPerson.id, is_deleted: false,
      });
      const speakerPartIds = speakerParts.map((p: any) => p.id);
      if (speakerPartIds.length > 0) {
        const allSessions = await svc.entities.Session.filter({ event_id: scopeEventId, is_deleted: false });
        const speakerSessionIds = allSessions
          .filter((s: any) => speakerPartIds.includes(s.speaker_id))
          .map((s: any) => s.id);
        if (speakerSessionIds.length > 0) {
          const attendance = await svc.entities.SessionAttendance.filter({
            event_id: scopeEventId, is_present: true, session_id: { $in: speakerSessionIds },
          });
          // attendedParticipantIds is O(attendance) — business logic, not recipient Set
          const attendedParticipantIds = new Set(attendance.map((a: any) => a.participant_id));
          let skip = 0;
          while (true) {
            const parts = await svc.entities.Participant.filter(
              { event_id: scopeEventId, is_deleted: false }, "id", BATCH_SIZE, skip
            );
            if (parts.length === 0) break;
            const batch: Recipient[] = parts
              .filter((p: any) => attendedParticipantIds.has(p.id))
              .map((p: any) => ({
                user_id: p.id, name: p.full_name || "", email: p.email || "",
                role: p.role_in_event || "attendee",
              }));
            if (batch.length > 0) yield batch;
            skip += BATCH_SIZE;
            if (parts.length < BATCH_SIZE) break;
          }
        }
      }
    }
  }

  // --- Sender always receives their own message ---
  if (senderUser) {
    yield [{
      user_id: senderUser.id,
      name: senderUser.full_name || "",
      email: senderUser.email || "",
      role: senderUser.role || "",
    }];
  }
}

// =============================================================================
// Process a batch: within-batch dedup → cross-batch dedup via $in → bulkCreate
// =============================================================================
async function processRecipientBatch(
  svc: any,
  campaignId: string,
  recipients: Recipient[],
  stats: any
): Promise<void> {
  if (recipients.length === 0) return;

  // Within-batch dedup by user_id (O(batch) Set)
  const localSeen = new Set<string>();
  const unique: Recipient[] = [];
  for (const r of recipients) {
    if (!r.user_id || localSeen.has(r.user_id)) continue;
    localSeen.add(r.user_id);
    unique.push(r);
  }
  if (unique.length === 0) return;

  // Cross-batch dedup: single $in query (1 query per batch, not N)
  const existing = await svc.entities.NotificationRecipient.filter({
    campaign_id: campaignId,
    recipient_user_id: { $in: unique.map((r) => r.user_id) },
  }, undefined, unique.length);
  stats.queries++;
  stats.resolutionBatches++;
  const existingIds = new Set(existing.map((r: any) => r.recipient_user_id));

  const toCreate = unique.filter((r) => !existingIds.has(r.user_id));
  if (toCreate.length === 0) return;

  // Create as "pending" — NOT yet delivered
  await svc.entities.NotificationRecipient.bulkCreate(
    toCreate.map((r) => ({
      campaign_id: campaignId,
      recipient_user_id: r.user_id,
      recipient_name: r.name,
      recipient_email: r.email,
      recipient_role: r.role,
      delivery_status: "pending",
    }))
  );
  stats.queries++;
  stats.created += toCreate.length;
}

// =============================================================================
// Count recipients by status — paginated, O(batch) memory
// =============================================================================
async function countRecipientsByStatus(
  svc: any,
  campaignId: string,
  stats: any
): Promise<{ total: number; sent: number; failed: number; pending: number }> {
  let total = 0, sent = 0, failed = 0, pending = 0;
  let skip = 0;
  while (true) {
    const batch = await svc.entities.NotificationRecipient.filter(
      { campaign_id: campaignId }, "id", BATCH_SIZE, skip
    );
    stats.queries++;
    if (batch.length === 0) break;
    for (const r of batch) {
      total++;
      if (r.delivery_status === "sent") sent++;
      else if (r.delivery_status === "failed") failed++;
      else pending++; // pending or processing
    }
    if (batch.length < BATCH_SIZE) break;
    skip += BATCH_SIZE;
  }
  return { total, sent, failed, pending };
}

// =============================================================================
// Main handler
// =============================================================================
Deno.serve(async (req) => {
  const stats = {
    resolutionBatches: 0,
    deliveryBatches: 0,
    created: 0,
    delivered: 0,
    failed: 0,
    queries: 0,
    startTime: Date.now(),
  };

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { campaign: campaignInput, senderPartnerId } = await req.json();
    if (!campaignInput?.id) return Response.json({ error: 'Campaign obrigatória.' }, { status: 400 });

    // P0.2: Fetch campaign from DB — don't trust client-provided scope/audience
    const campaignRecords = await base44.asServiceRole.entities.NotificationCampaign.filter({ id: campaignInput.id });
    const campaign = campaignRecords[0];
    if (!campaign) return Response.json({ error: 'Campanha não encontrada.' }, { status: 404 });

    // === Authorization (UNCHANGED) ===
    if (campaign.scope_event_id) {
      const broadcastAudiences = ['all', 'segment', 'manual'];
      if (broadcastAudiences.includes(campaign.audience_type)) {
        const canDispatch = await verifyEventMembership(base44, user, campaign.scope_event_id, EVENT_MANAGER_ROLES);
        if (!canDispatch.authorized) {
          return Response.json({ error: 'Sem permissão para enviar campanhas neste evento.' }, { status: 403 });
        }
      } else {
        if (!campaign.sender_user_id) {
          return Response.json({ error: 'Campanhas partner/speaker requerem sender_user_id.' }, { status: 403 });
        }
        if (campaign.sender_user_id !== user.id) {
          return Response.json({ error: 'Sem permissão para enviar esta campanha.' }, { status: 403 });
        }
        const partnerAudiences = ['my_leads', 'partner_leads', 'partner_all_event'];
        if (partnerAudiences.includes(campaign.audience_type) && senderPartnerId) {
          let repRecords = await base44.asServiceRole.entities.PartnerRepresentative.filter({
            partner_id: senderPartnerId, user_id: user.id, is_active: true, is_deleted: false,
          });
          if (repRecords.length === 0) {
            const persons = await base44.asServiceRole.entities.Person.filter({ contact_email: user.email, is_active: true });
            if (persons.length > 0) {
              repRecords = await base44.asServiceRole.entities.PartnerRepresentative.filter({
                partner_id: senderPartnerId, person_id: persons[0].id, is_active: true, is_deleted: false,
              });
            }
          }
          if (repRecords.length === 0) {
            return Response.json({ error: 'senderPartnerId não pertence ao usuário autenticado.' }, { status: 403 });
          }
          const eventPartners = await base44.asServiceRole.entities.EventPartner.filter({
            event_id: campaign.scope_event_id, partner_id: senderPartnerId, is_active: true, is_deleted: false,
          });
          if (eventPartners.length === 0) {
            return Response.json({ error: 'Partner não está associado a este evento.' }, { status: 403 });
          }
        }
        const hasAnyMembership = await verifyAnyEventMembership(base44, user, campaign.scope_event_id);
        if (!hasAnyMembership.authorized) {
          return Response.json({ error: 'Sem permissão para enviar campanhas neste evento.' }, { status: 403 });
        }
      }
    } else {
      if (user.role !== 'admin') {
        return Response.json({ error: 'Apenas administradores podem enviar campanhas globais.' }, { status: 403 });
      }
    }

    const svc = base44.asServiceRole;

    // === Logical guard: campaign.status = "processing" ===
    // NOT a lock. Without CAS/UNIQUE/atomic-lock, two concurrent workers can
    // both read "pending" and both set "processing". This is an application-
    // level guard to prevent accidental re-dispatch via UI, NOT a concurrency
    // safety mechanism. Risco residual: duplicate processing se dois workers
    // executam simultaneamente.
    await svc.entities.NotificationCampaign.update(campaign.id, {
      status: "processing",
    });
    stats.queries++;

    // === Phase 1: Resolve audience + create recipients as "pending" ===
    // Batched: O(batch) memory. No User.list() global. No global recipients Set.
    // Dedup via $in query per batch (1 query, not N per batch).
    try {
      for await (const batch of resolveAudienceBatches(svc, {
        scopeType: campaign.scope_type,
        scopeEventId: campaign.scope_event_id,
        audienceType: campaign.audience_type,
        audienceSegments: campaign.audience_payload ? JSON.parse(campaign.audience_payload) : [],
        senderUser: user,
        senderPartnerId,
      })) {
        await processRecipientBatch(svc, campaign.id, batch, stats);
      }
    } catch (e) {
      await svc.entities.NotificationCampaign.update(campaign.id, { status: "failed" });
      stats.queries++;
      return Response.json({
        ok: false,
        error: 'Falha ao resolver destinatários: ' + e.message,
        stats,
      }, { status: 500 });
    }

    // === Phase 2: Deliver — process pending/processing/failed → sent ===
    // Query always starts at skip=0: processed records leave the result set
    // (their delivery_status changes from pending/processing/failed to sent/failed).
    // "sent" is terminal and never reprocessed.
    while (true) {
      const batch = await svc.entities.NotificationRecipient.filter(
        {
          campaign_id: campaign.id,
          delivery_status: { $in: ["pending", "processing", "failed"] },
        },
        "id", BATCH_SIZE, 0
      );
      stats.queries++;
      if (batch.length === 0) break;

      // Mark as "processing" — best-effort, NOT a lock.
      // Two workers could both grab this batch (no atomic claim exists in Base44).
      // Risco residual: duplicate-send (ambos marcam como "sent").
      await svc.entities.NotificationRecipient.bulkUpdate(
        batch.map((r: any) => ({ id: r.id, delivery_status: "processing" }))
      );
      stats.queries++;

      try {
        // "Send" — update to "sent" with delivered_at.
        // In-app delivery: the notification becomes visible in the recipient's
        // NotificationInbox (which filters by delivery_status: "sent").
        const now = new Date().toISOString();
        await svc.entities.NotificationRecipient.bulkUpdate(
          batch.map((r: any) => ({ id: r.id, delivery_status: "sent", delivered_at: now }))
        );
        stats.queries++;
        stats.delivered += batch.length;
      } catch (e: any) {
        await svc.entities.NotificationRecipient.bulkUpdate(
          batch.map((r: any) => ({ id: r.id, delivery_status: "failed", error_reason: e.message }))
        );
        stats.queries++;
        stats.failed += batch.length;
      }

      stats.deliveryBatches++;
      if (batch.length < BATCH_SIZE) break;
    }

    // === Final count (paginated, O(batch) memory) ===
    const counts = await countRecipientsByStatus(svc, campaign.id, stats);

    const now = new Date().toISOString();
    const campaignStatus = counts.pending > 0
      ? "partially_sent"
      : (counts.failed > 0 ? "partially_sent" : "sent");

    await svc.entities.NotificationCampaign.update(campaign.id, {
      status: campaignStatus,
      sent_at: now,
      recipients_count: counts.total,
      delivered_count: counts.sent,
    });
    stats.queries++;

    stats.totalTimeMs = Date.now() - stats.startTime;

    return Response.json({
      ok: true,
      recipients_count: counts.total,
      delivered_count: counts.sent,
      failed_count: counts.failed,
      pending_count: counts.pending,
      stats,
    });
  } catch (error) {
    stats.totalTimeMs = Date.now() - stats.startTime;
    return Response.json({ error: error.message, stats }, { status: 500 });
  }
});