// =============================================================================
// NotificationCampaign — Batched dispatch with state machine
// =============================================================================
//
// GARANTIA DE ENTREGA: "at-least-once processing/attempt semantics, with
// possible duplicate delivery."
//
// SEMÂNTICA DE IDENTIDADE (P0 — correção de entrega):
//   User = conta do app (pode nunca ter entrado em evento nenhum).
//   Participant = quem participa de um evento específico.
//   EventMembership = papel da pessoa no evento (mestre de papéis, ancorada em user_id).
//
//   recipient_user_id é SEMPRE o ID do User (a RLS da entidade e o inbox casam
//   com {{user.id}}). Antes, audiências de evento gravavam o ID do Participant —
//   a notificação constava como entregue mas NUNCA aparecia no inbox.
//
// RESOLUÇÃO DE AUDIÊNCIA:
//   - Segmentos de papel (gerente/staff/palestrante/representante): via
//     EventMembership ativa do evento, ancorada em user_id — apenas membros com
//     conta vinculada geram recipient.
//   - Audiências de participante (all/attendee/my_leads/partner_leads/
//     partner_all_event/my_attendees): Participant → e-mail → User (batched $in).
//     Participante SEM conta de app NÃO gera registro (regra de negócio).
//   - Audiência 'all' do evento = participantes do evento com conta de app
//     (uma única notificação por pessoa — a regra antiga de 'dois registros'
//     participante+usuário foi extinta). 'all' global (sem evento) = todos os Users.
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
//   1. campaign.status = "processing" NÃO é um lock — o claim CAS do handler
//      principal (updateMany condicional) é quem garante um único dispatcher.
//
//   2. idempotency_key (campaignId:userId) é apenas identificação lógica.
//      A deduplicação via $in query em recipient_user_id reduz a probabilidade
//      de duplicatas entre batches, mas NÃO é uma garantia atômica.
//
// PERFORMANCE — O(batch) memory em TODAS as paths (batch=500):
//   Resolução paginada por BATCH_SIZE; dedup cross-batch por user_id via query
//   $in (1 query/batch). Sem Sets globais, sem User.list() sem paginação.
// =============================================================================

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { verifyEventMembership, verifyAnyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";
import { requireActiveUser } from "../../shared/accountSecurity.ts";

const BATCH_SIZE = 500;

type Recipient = { user_id: string; name: string; email: string; role: string };
type YieldedBatch = { recipients: Recipient[] };

// =============================================================================
// Participant → User (batched $in por e-mail).
// Participante sem conta de app NÃO gera recipient (regra de negócio — o
// inbox e a RLS casam por User ID; um registro por Participant ID seria morto).
// =============================================================================
async function participantsToRecipients(svc: any, parts: any[]): Promise<Recipient[]> {
  const emailVariants = new Set<string>();
  for (const p of parts) {
    const raw = String(p?.email || "").trim();
    if (raw) {
      emailVariants.add(raw);
      emailVariants.add(raw.toLowerCase());
    }
  }
  if (emailVariants.size === 0) return [];

  const users = await svc.entities.User.filter(
    { email: { $in: Array.from(emailVariants) }, account_status: { $ne: "deleted" } },
    "id", emailVariants.size
  );
  const usersByEmail = new Map<string, any>();
  for (const u of users) {
    if (u.email) {
      const key = String(u.email).toLowerCase();
      if (!usersByEmail.has(key)) usersByEmail.set(key, u);
    }
  }

  const out: Recipient[] = [];
  for (const p of parts) {
    const u = usersByEmail.get(String(p?.email || "").toLowerCase());
    if (!u) continue; // sem conta de app → não cria registro
    out.push({
      user_id: u.id,
      name: p.full_name || u.full_name || "",
      email: u.email || p.email || "",
      role: p.role_in_event || "attendee",
    });
  }
  return out;
}

// =============================================================================
// Async Generator: Resolve audience in batches of up to BATCH_SIZE.
// Every recipient's user_id is a real User ID (see identity semantics above).
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
  const { scopeEventId, audienceType, audienceSegments = [], senderUser, senderPartnerId } = params;

  const isAll = audienceType === "all" || (audienceType === "segment" && audienceSegments.includes("all"));

  if (isAll) {
    if (scopeEventId) {
      // --- Evento: todos os participantes do evento com conta de app ---
      // Um único recipient por pessoa (dedup por user_id dentro/cross-batch).
      let skip = 0;
      while (true) {
        const parts = await svc.entities.Participant.filter(
          { event_id: scopeEventId, is_deleted: false, is_eligible: { $ne: false } }, "id", BATCH_SIZE, skip
        );
        if (parts.length === 0) break;
        const recipients = await participantsToRecipients(svc, parts);
        if (recipients.length > 0) yield { recipients };
        skip += BATCH_SIZE;
        if (parts.length < BATCH_SIZE) break;
      }
    } else {
      // --- Global (sem evento): todos os Users do app (paginado) ---
      let skip = 0;
      while (true) {
        const users = await svc.entities.User.filter({ account_status: { $ne: "deleted" } }, "id", BATCH_SIZE, skip);
        if (users.length === 0) break;
        yield {
          recipients: users.map((u: any) => ({
            user_id: u.id, name: u.full_name || "", email: u.email || "", role: u.role || "",
          })),
        };
        skip += BATCH_SIZE;
        if (users.length < BATCH_SIZE) break;
      }
    }
  } else if (audienceType === "segment") {
    // --- Segmentos globais via User.role (apenas admin; attendee sem evento) ---
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
        if (batch.length > 0) yield { recipients: batch };
        skip += BATCH_SIZE;
        if (users.length < BATCH_SIZE) break;
      }
    }

    if (scopeEventId) {
      // --- Segmentos de papel do evento via EventMembership (P0) ---
      // Mestre de papéis, ancorada em user_id — sem lookup de e-mail. Apenas
      // membros com conta vinculada (user_id preenchido) geram recipient.
      const membershipSegMap: Record<string, string> = {
        gerente: "manager",
        staff: "team",
        palestrante: "speaker",
        representante: "partner_rep",
      };

      for (const seg of audienceSegments) {
        const role = membershipSegMap[seg];
        if (!role) continue;
        let skip = 0;
        while (true) {
          const memberships = await svc.entities.EventMembership.filter(
            {
              event_id: scopeEventId,
              role,
              is_active: true,
              is_deleted: false,
              user_id: { $ne: "" },
            },
            "id", BATCH_SIZE, skip
          );
          if (memberships.length === 0) break;
          yield {
            recipients: memberships.map((m: any) => ({
              user_id: m.user_id,
              name: m.person_name || m.user_email || "",
              email: m.user_email || "",
              role: m.role,
            })),
          };
          skip += BATCH_SIZE;
          if (memberships.length < BATCH_SIZE) break;
        }
      }

      // --- Segmento 'attendee' do evento: todos os participantes com conta ---
      if (audienceSegments.includes("attendee")) {
        let skip = 0;
        while (true) {
          const parts = await svc.entities.Participant.filter(
            { event_id: scopeEventId, is_deleted: false, is_eligible: { $ne: false } }, "id", BATCH_SIZE, skip
          );
          if (parts.length === 0) break;
          const recipients = await participantsToRecipients(svc, parts);
          if (recipients.length > 0) yield { recipients };
          skip += BATCH_SIZE;
          if (parts.length < BATCH_SIZE) break;
        }
      }
    }
  } else if (audienceType === "my_leads" && senderUser && senderPartnerId && scopeEventId) {
    // Leads do parceiro → participantes elegíveis → User por e-mail
    let skip = 0;
    while (true) {
      const leads = await svc.entities.Lead.filter(
        { event_id: scopeEventId, partner_id: senderPartnerId },
        "id", BATCH_SIZE, skip
      );
      if (leads.length === 0) break;
      const leadPartIds = new Set<string>();
      for (const l of leads) if (l.participant_id) leadPartIds.add(l.participant_id);
      if (leadPartIds.size > 0) {
        const eligibleParts = await svc.entities.Participant.filter(
          { id: { $in: Array.from(leadPartIds) }, is_eligible: { $ne: false }, is_deleted: false },
          "id", leadPartIds.size, 0
        );
        const recipients = await participantsToRecipients(svc, eligibleParts);
        if (recipients.length > 0) yield { recipients };
      }
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
      const recipients = await participantsToRecipients(svc, parts);
      if (recipients.length > 0) yield { recipients };
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
      const leadPartIds = new Set<string>();
      for (const l of leads) if (l.participant_id) leadPartIds.add(l.participant_id);
      if (leadPartIds.size > 0) {
        const eligibleParts = await svc.entities.Participant.filter(
          { id: { $in: Array.from(leadPartIds) }, is_eligible: { $ne: false }, is_deleted: false },
          "id", leadPartIds.size, 0
        );
        const recipients = await participantsToRecipients(svc, eligibleParts);
        if (recipients.length > 0) yield { recipients };
      }
      skip += BATCH_SIZE;
      if (leads.length < BATCH_SIZE) break;
    }
  } else if (audienceType === "my_attendees" && senderUser && scopeEventId) {
    // Paginated resolution: Sender → Person → Speaker Participant → Sessions →
    // Attendance → Participants → User (por e-mail). O(batch) memory em todas as etapas.

    // Step 1: senderUser → Person (O(1) result)
    const persons = await svc.entities.Person.filter({ contact_email: senderUser.email, is_active: true });
    const speakerPerson = persons?.[0];
    if (speakerPerson) {
      // Step 2: Person → Speaker's Participant records (paginated, collect IDs)
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
          // Step 4+5: Sessions → Attendance (paginado) → Participants → User
          let skipA = 0;
          while (true) {
            const attendance = await svc.entities.SessionAttendance.filter(
              { event_id: scopeEventId, is_present: true, session_id: { $in: speakerSessionIds } },
              "id", BATCH_SIZE, skipA
            );
            if (attendance.length === 0) break;

            const batchPartIds = new Set<string>();
            for (const a of attendance) {
              if (a.participant_id) batchPartIds.add(a.participant_id);
            }

            if (batchPartIds.size > 0) {
              const parts = await svc.entities.Participant.filter(
                { id: { $in: Array.from(batchPartIds) }, is_deleted: false, is_eligible: { $ne: false } },
                "id", BATCH_SIZE, 0
              );
              const recipients = await participantsToRecipients(svc, parts);
              if (recipients.length > 0) yield { recipients };
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
    };
  }
}

// =============================================================================
// Process a batch: within-batch dedup by user_id → cross-batch dedup via $in →
// bulkCreate as "pending" (not yet visible in inbox).
// recipient_email stored in lowercase for consistent matching.
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

  // Cross-batch dedup by user_id (1 query per batch)
  const existingByUserId = await svc.entities.NotificationRecipient.filter({
    campaign_id: campaignId,
    recipient_user_id: { $in: unique.map((r) => r.user_id) },
  }, undefined, unique.length);
  stats.queries++;
  stats.resolutionBatches++;
  const existingIds = new Set(existingByUserId.map((r: any) => r.recipient_user_id));

  const toCreate = unique.filter((r) => !existingIds.has(r.user_id));
  if (toCreate.length === 0) return;

  // Create as "pending" — NOT yet delivered (not visible in inbox)
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

    // === Lock atômico da campanha (compare-and-swap em status) ===
    // updateMany condicional = CAS: só um worker consegue virar status para
    // "processing" a partir de draft/scheduled (novo envio) ou
    // partially_sent/failed (retry de pendentes). Concorrentes recebem 409 —
    // sem duplicate processing. "processing" (em curso) e "sent"/"canceled"
    // não são reassumíveis.
    const claim = await svc.entities.NotificationCampaign.updateMany(
      { id: campaign.id, status: { $in: ["draft", "scheduled", "partially_sent", "failed"] } },
      { $set: { status: "processing" } }
    );
    stats.queries++;
    if (!claim || !claim.updated) {
      return Response.json({ error: 'Envio já em andamento ou já concluído.' }, { status: 409 });
    }
    // Auditoria da assunção do lock: quem assumiu o envio e quando.
    try {
      await svc.entities.AuditLog.create({
        action: 'status_change',
        entity_type: 'NotificationCampaign',
        entity_id: campaign.id,
        details: JSON.stringify({ type: 'dispatch_lock_acquired' }),
        event_id: campaign.scope_event_id || '',
        user_id: user.id,
      });
      stats.queries++;
    } catch {}

    // === Phase 1: Resolve audience + create recipients as "pending" ===
    // Batched: O(batch) memory. No User.list() global. No global recipients Set.
    try {
      for await (const { recipients } of resolveAudienceBatches(svc, {
        scopeType: campaign.scope_type,
        scopeEventId: campaign.scope_event_id,
        audienceType: campaign.audience_type,
        audienceSegments: campaign.audience_payload ? JSON.parse(campaign.audience_payload) : [],
        senderUser: user,
        senderPartnerId,
      })) {
        await processRecipientBatch(svc, campaign.id, recipients, stats);
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

      // Mark as "processing" — sinal de work-in-progress. O lock atômico da
      // campanha (CAS acima) garante que apenas um worker percorre esta fila.
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