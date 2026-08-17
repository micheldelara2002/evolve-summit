// =============================================================================
// P0 NotificationCampaign — Batched dispatch with state machine
// =============================================================================
//
// GARANTIA DE ENTREGA: "at-least-once processing/attempt semantics, with
// possible duplicate delivery."
//
// SEMÂNTICA DE ENTREGA — 4 fases distintas (SEM provider externo):
//
//   1. Criação do recipient: bulkCreate delivery_status="pending" na fase
//      de resolução. O registro existe no DB mas NÃO é visível no inbox.
//
//   2. Processamento: bulkUpdate delivery_status="processing" antes do
//      envio. Sinal de work-in-progress. NÃO é um lock atômico.
//
//   3. Materialização in-app: bulkUpdate delivery_status="sent" com
//      delivered_at. O registro torna-se visível no NotificationInbox do
//      destinatário (que filtra por delivery_status: "sent"). ESTA é a
//      "entrega" no contexto do Base44 — NÃO há provider externo (email/push).
//
//   4. Entrega efetiva ao usuário: notificação renderizada no
//      NotificationInbox do destinatário. Fora do controle do Base44 —
//      depende do destinatário abrir o app e visualizar o inbox.
//
// STATE MACHINE (NotificationRecipient.delivery_status):
//   pending → processing → sent   (sucesso — materializado in-app)
//   pending → processing → failed  (erro)
//
//   - "sent" é terminal: NUNCA reprocessado.
//   - Retry processa pending, processing (stuck por crash) e failed.
//
// CONCORRÊNCIA — LIMITAÇÕES EXPLÍCITAS (sem CAS/UNIQUE/lock atômico no Base44):
//
//   1. campaign.status = "processing" NÃO é um lock.
//      Dois workers podem ambos ler "pending" e ambos setar "processing".
//      status é apenas um guard lógico de aplicação (impede reenvio via UI).
//
//   2. NÃO existe claim/lock atômico de batch.
//      Dois workers podem ler o mesmo batch e ambos processar.
//      Risco residual: duplicate-send (ambos marcam como "sent").
//
//   3. idempotency_key (campaignId:userId) é apenas identificação lógica.
//      Sem UNIQUE constraint, dois workers podem ambos criar recipients
//      para o mesmo userId. A deduplicação via $in query reduz a
//      probabilidade mas NÃO é uma garantia atômica.
//
//   4. Retry seguro: recipients "sent" são terminais e nunca reprocessados.
//
// PERFORMANCE — O(batch) memory em TODAS as paths (batch=500):
//
//   RESOLUÇÃO DE AUDIÊNCIA (AsyncGenerator, batches de 500):
//     - "all": Participants do evento (com dedup de email cross-batch via
//       query $in em recipient_email) → Users globais → Sender.
//       ORDEM: Participants ANTES de Users para que a query $in em
//       recipient_email só matched recipients de batches anteriores de
//       Participants (preserva regra: User+Participant mesmo email → ambos
//       recebem notificação). O Set de email é PER-BATCH (O(500)), não global.
//     - "segment": Users por role → Participants por role_in_event.
//     - "my_leads"/"partner_leads": Leads do partner (paginado).
//     - "partner_all_event": Participants do evento (sem dedup de email).
//     - "my_attendees": Speaker → Sessions (paginado por speaker_id $in) →
//       Attendance (paginado) → Participants (por batch, via id $in).
//       Sem Sets globais; cross-batch dedup via processRecipientBatch.
//     - Sender sempre recebe sua própria mensagem (regra de negócio).
//
//   DEDUP CROSS-BATCH:
//     - Por user_id: query $in em recipient_user_id (1 query/batch).
//     - Por email (apenas "all" Participants): query $in em recipient_email
//       (1 query adicional/batch). recipient_email armazenado em lowercase.
//
//   DELIVERY: bulkUpdate em batches de 500. O(batch) memory.
//   FINAL COUNT: paginação por skip. O(batch) memory, O(N/batch) queries.
//
// ESTRUTURAS NÃO-GLOBAIS (O(batch) ou O(speaker-data), nunca O(N)):
//   - speakerPartIds: O(participant records do speaker) — tipicamente 1-3.
//   - speakerSessionIds: O(sessions do speaker) — tipicamente <50.
//   - Per-batch Sets (localSeen, batchEmails, batchPartIds): O(500).
//
// COMPLEXIDADE:
//   - Memory: O(500) em todas as paths. Para 1M recipients: sem OOM.
//   - Queries: O(N/500) resolução + O(N/500) delivery + O(N/500) count.
//     Para 1M: ~2000 batches, ~6000 queries. Sem truncamento.
// =============================================================================

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { verifyEventMembership, verifyAnyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";
import { requireActiveUser } from "../../shared/accountSecurity.ts";

const BATCH_SIZE = 500;

type Recipient = { user_id: string; name: string; email: string; role: string };
type YieldedBatch = { recipients: Recipient[]; dedupByEmail: boolean };

// =============================================================================
// Async Generator: Resolve audience in batches of up to BATCH_SIZE.
// Yields { recipients, dedupByEmail }. dedupByEmail=true ONLY for "all"
// audience Participants (preserves original email dedup business rule).
// Within-batch dedup by user_id applied in processRecipientBatch.
// Cross-batch dedup by user_id (and email when dedupByEmail) via $in query.
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
): AsyncGenerator<YieldedBatch> {
  const { scopeType, scopeEventId, audienceType, audienceSegments = [], senderUser, senderPartnerId } = params;

  const isAll = audienceType === "all" || (audienceType === "segment" && audienceSegments.includes("all"));

  if (isAll) {
    // --- All Participants of the event (FIRST — email dedup applies) ---
    // Yielded BEFORE Users so cross-batch email dedup $in query on
    // recipient_email only matches recipients from previous Participants
    // batches. Preserves business rule: User + Participant with same email
    // → both receive notifications (Users batch uses dedupByEmail=false).
    if (scopeEventId) {
      let skip = 0;
      while (true) {
        const parts = await svc.entities.Participant.filter(
          { event_id: scopeEventId, is_deleted: false, is_eligible: { $ne: false } }, "id", BATCH_SIZE, skip
        );
        if (parts.length === 0) break;
        // Per-batch email dedup Set — O(batch), replaces former global emailSeen
        const batchEmails = new Set<string>();
        const batch: Recipient[] = [];
        for (const p of parts) {
          const key = p.email?.toLowerCase();
          if (!key || batchEmails.has(key)) continue;
          batchEmails.add(key);
          batch.push({
            user_id: p.id, name: p.full_name || "", email: p.email || "",
            role: p.role_in_event || "attendee",
          });
        }
        if (batch.length > 0) yield { recipients: batch, dedupByEmail: true };
        skip += BATCH_SIZE;
        if (parts.length < BATCH_SIZE) break;
      }
    }

    // --- All Users (paginated, O(batch) memory, no email dedup) ---
    let skip = 0;
    while (true) {
      const users = await svc.entities.User.filter({ account_status: { $ne: "deleted" } }, "id", BATCH_SIZE, skip);
      if (users.length === 0) break;
      yield {
        recipients: users.map((u: any) => ({
          user_id: u.id, name: u.full_name || "", email: u.email || "", role: u.role || "",
        })),
        dedupByEmail: false,
      };
      skip += BATCH_SIZE;
      if (users.length < BATCH_SIZE) break;
    }
  } else if (audienceType === "segment") {
    // --- Segment: User.role GLOBAL filters only ---
    // Apenas "admin" (User.role=admin) e "attendee" global (User.role=user) são
    // resolvidos via User.role. Demais segmentos (gerente/staff/palestrante/
    // representante) são resolvidos via Participant.role_in_event abaixo
    // (participantSegMap) — NÃO via User.role, que só é admin|user.
    const userRoleMap: Record<string, string> = {};
    for (const seg of audienceSegments) {
      if (seg === "admin") userRoleMap["admin"] = "admin";
      if (seg === "attendee" && !scopeEventId) userRoleMap["user"] = "user";
    }

    const userRoles = Object.keys(userRoleMap);
    if (userRoles.length > 0) {
      let skip = 0;
      while (true) {
        const users = await svc.entities.User.filter({ account_status: { $ne: "deleted" } }, "id", BATCH_SIZE, skip);
        if (users.length === 0) break;
        const batch: Recipient[] = users
          .filter((u: any) => userRoles.includes(u.role))
          .map((u: any) => ({
            user_id: u.id, name: u.full_name || "", email: u.email || "",
            role: userRoleMap[u.role] || u.role || "",
          }));
        if (batch.length > 0) yield { recipients: batch, dedupByEmail: false };
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
          { event_id: scopeEventId, role_in_event: roleInEvent, is_deleted: false, is_eligible: { $ne: false } },
          "id", BATCH_SIZE, skip
        );
        if (parts.length === 0) break;
        yield {
          recipients: parts.map((p: any) => ({
            user_id: p.id, name: p.full_name || "", email: p.email || "", role: roleLabel,
          })),
          dedupByEmail: false,
        };
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
      // Exclude leads pointing to ineligible (deleted) participants
      const leadPartIds = leads.map((l: any) => l.participant_id).filter(Boolean);
      let eligibleLeadPartIds = new Set<string>(leadPartIds);
      if (leadPartIds.length > 0) {
        const eligible = await svc.entities.Participant.filter(
          { id: { $in: leadPartIds }, is_eligible: { $ne: false } }, "id", leadPartIds.length, 0
        );
        eligibleLeadPartIds = new Set(eligible.map((p: any) => p.id));
      }
      const leadBatch = leads
        .filter((l: any) => l.participant_id && eligibleLeadPartIds.has(l.participant_id))
        .map((l: any) => ({
          user_id: l.participant_id, name: l.participant_name || "",
          email: l.participant_email || "", role: "attendee",
        }));
      if (leadBatch.length > 0) yield { recipients: leadBatch, dedupByEmail: false };
      skip += BATCH_SIZE;
      if (leads.length < BATCH_SIZE) break;
    }
  } else if (audienceType === "partner_all_event" && scopeEventId) {
    let skip = 0;
    while (true) {
      const parts = await svc.entities.Participant.filter(
        { event_id: scopeEventId, is_deleted: false, is_eligible: { $ne: false } }, "id", BATCH_SIZE, skip
      );
      if (parts.length === 0) break;
      yield {
        recipients: parts.map((p: any) => ({
          user_id: p.id, name: p.full_name || "", email: p.email || "",
          role: p.role_in_event || "attendee",
        })),
        dedupByEmail: false,
      };
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
      // Exclude leads pointing to ineligible (deleted) participants
      const leadPartIds = leads.map((l: any) => l.participant_id).filter(Boolean);
      let eligibleLeadPartIds = new Set<string>(leadPartIds);
      if (leadPartIds.length > 0) {
        const eligible = await svc.entities.Participant.filter(
          { id: { $in: leadPartIds }, is_eligible: { $ne: false } }, "id", leadPartIds.length, 0
        );
        eligibleLeadPartIds = new Set(eligible.map((p: any) => p.id));
      }
      const leadBatch = leads
        .filter((l: any) => l.participant_id && eligibleLeadPartIds.has(l.participant_id))
        .map((l: any) => ({
          user_id: l.participant_id, name: l.participant_name || "",
          email: l.participant_email || "", role: "attendee",
        }));
      if (leadBatch.length > 0) yield { recipients: leadBatch, dedupByEmail: false };
      skip += BATCH_SIZE;
      if (leads.length < BATCH_SIZE) break;
    }
  } else if (audienceType === "my_attendees" && senderUser && scopeEventId) {
    // Paginated resolution: Speaker → Person → Participant → Sessions →
    // Attendance → Participants. ALL O(batch) memory. No global Sets.
    // Cross-batch participant dedup handled by processRecipientBatch ($in
    // on recipient_user_id — a participant in multiple sessions appears in
    // multiple attendance batches, but $in catches the duplicate create).

    // Step 1: senderUser → Person (O(1) result)
    const persons = await svc.entities.Person.filter({ contact_email: senderUser.email, is_active: true });
    const speakerPerson = persons?.[0];
    if (speakerPerson) {
      // Step 2: Person → Speaker's Participant records (paginated, collect IDs)
      // O(speaker's participant records) — bounded, typically 1-3.
      const speakerPartIds: string[] = [];
      let skipP = 0;
      while (true) {
        const speakerParts = await svc.entities.Participant.filter(
          { event_id: scopeEventId, person_id: speakerPerson.id, is_deleted: false },
          "id", BATCH_SIZE, skipP
        );
        if (speakerParts.length === 0) break;
        for (const p of speakerParts) speakerPartIds.push(p.id);
        skipP += BATCH_SIZE;
        if (speakerParts.length < BATCH_SIZE) break;
      }

      if (speakerPartIds.length > 0) {
        // Step 3: Speaker's Participant IDs → Sessions (paginated by speaker_id $in)
        // O(speaker's sessions) — bounded, typically <50. Replaces former
        // allSessions (which loaded ALL event sessions unpaginated — O(S)).
        const speakerSessionIds: string[] = [];
        let skipS = 0;
        while (true) {
          const sessions = await svc.entities.Session.filter(
            { event_id: scopeEventId, speaker_id: { $in: speakerPartIds }, is_deleted: false },
            "id", BATCH_SIZE, skipS
          );
          if (sessions.length === 0) break;
          for (const s of sessions) speakerSessionIds.push(s.id);
          skipS += BATCH_SIZE;
          if (sessions.length < BATCH_SIZE) break;
        }

        if (speakerSessionIds.length > 0) {
          // Step 4+5: Sessions → Attendance (paginated) → Participants (per batch)
          // O(batch) memory. Replaces former global attendance array (O(A))
          // and attendedParticipantIds Set (O(A)).
          let skipA = 0;
          while (true) {
            const attendance = await svc.entities.SessionAttendance.filter(
              { event_id: scopeEventId, is_present: true, session_id: { $in: speakerSessionIds } },
              "id", BATCH_SIZE, skipA
            );
            if (attendance.length === 0) break;

            // Extract unique participant_ids from this batch (O(batch) Set)
            const batchPartIds = new Set<string>();
            for (const a of attendance) {
              if (a.participant_id) batchPartIds.add(a.participant_id);
            }

            if (batchPartIds.size > 0) {
              // Query Participants for these IDs (O(batch) result)
              const parts = await svc.entities.Participant.filter(
                { id: { $in: Array.from(batchPartIds) }, is_deleted: false, is_eligible: { $ne: false } },
                "id", BATCH_SIZE, 0
              );
              const batch: Recipient[] = parts.map((p: any) => ({
                user_id: p.id, name: p.full_name || "", email: p.email || "",
                role: p.role_in_event || "attendee",
              }));
              if (batch.length > 0) yield { recipients: batch, dedupByEmail: false };
            }

            skipA += BATCH_SIZE;
            if (attendance.length < BATCH_SIZE) break;
          }
        }
      }
    }
  }

  // --- Sender always receives their own message (business rule) ---
  if (senderUser) {
    yield {
      recipients: [{
        user_id: senderUser.id,
        name: senderUser.full_name || "",
        email: senderUser.email || "",
        role: senderUser.role || "",
      }],
      dedupByEmail: false,
    };
  }
}

// =============================================================================
// Process a batch: within-batch dedup → cross-batch dedup via $in → bulkCreate
// When dedupByEmail=true: also queries recipient_email for cross-batch email
// dedup (preserves "all" audience Participants email dedup business rule).
// recipient_email stored in lowercase for case-insensitive $in matching.
// =============================================================================
async function processRecipientBatch(
  svc: any,
  campaignId: string,
  recipients: Recipient[],
  stats: any,
  dedupByEmail: boolean = false
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

  // Cross-batch dedup by user_id (1 query per batch)
  const existingByUserId = await svc.entities.NotificationRecipient.filter({
    campaign_id: campaignId,
    recipient_user_id: { $in: unique.map((r) => r.user_id) },
  }, undefined, unique.length);
  stats.queries++;
  stats.resolutionBatches++;
  const existingIds = new Set(existingByUserId.map((r: any) => r.recipient_user_id));

  // Cross-batch dedup by email (only when dedupByEmail — "all" Participants)
  // Replaces former global emailSeen Set (O(P)) with O(batch) query.
  let existingEmails = new Set<string>();
  if (dedupByEmail) {
    const emailsLower = unique.map((r) => (r.email || "").toLowerCase()).filter(Boolean);
    if (emailsLower.length > 0) {
      const existingByEmail = await svc.entities.NotificationRecipient.filter({
        campaign_id: campaignId,
        recipient_email: { $in: emailsLower },
      }, undefined, emailsLower.length);
      stats.queries++;
      existingEmails = new Set(existingByEmail.map((r: any) => (r.recipient_email || "").toLowerCase()));
    }
  }

  const toCreate = unique.filter((r) => {
    if (existingIds.has(r.user_id)) return false;
    if (dedupByEmail && r.email) {
      if (existingEmails.has(r.email.toLowerCase())) return false;
    }
    return true;
  });
  if (toCreate.length === 0) return;

  // Create as "pending" — NOT yet delivered (not visible in inbox)
  // recipient_email stored in lowercase for email dedup $in queries
  await svc.entities.NotificationRecipient.bulkCreate(
    toCreate.map((r) => ({
      campaign_id: campaignId,
      recipient_user_id: r.user_id,
      recipient_name: r.name,
      recipient_email: (r.email || "").toLowerCase(),
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
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

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
    // No global emailSeen Set — cross-batch email dedup via $in query.
    try {
      for await (const { recipients, dedupByEmail } of resolveAudienceBatches(svc, {
        scopeType: campaign.scope_type,
        scopeEventId: campaign.scope_event_id,
        audienceType: campaign.audience_type,
        audienceSegments: campaign.audience_payload ? JSON.parse(campaign.audience_payload) : [],
        senderUser: user,
        senderPartnerId,
      })) {
        await processRecipientBatch(svc, campaign.id, recipients, stats, dedupByEmail);
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

    // === Phase 2: Materialize in-app — process pending/processing/failed → sent ===
    // bulkUpdate to "sent" makes the notification visible in the recipient's
    // NotificationInbox (which filters by delivery_status: "sent").
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
        // Materialize in-app: update to "sent" with delivered_at.
        // The notification becomes visible in the recipient's NotificationInbox.
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