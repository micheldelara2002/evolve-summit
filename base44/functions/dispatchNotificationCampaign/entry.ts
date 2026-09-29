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

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { verifyEventMembership, verifyAnyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { scanBatches } from "../../shared/completeScan.ts";
// P0 (2026-09-29) — resolução de audiência extraída para shared (fonte ÚNICA,
// também usada pela contagem exata em countCampaignAudience).
import { resolveAudienceBatches, AUDIENCE_BATCH_SIZE as BATCH_SIZE } from "../../shared/campaignAudience.ts";

// P2 (2026-09-28) — Orçamento de tempo por invocação: campanhas MUITO grandes
// não cabem numa única execução da função. Ao atingir o orçamento, o handler
// encerra de forma limpa em um status REASSUMÍVEL (failed durante a resolução,
// partially_sent durante a entrega) e responde has_more=true — o service do
// frontend encadeia novas invocações até esgotar a fila. Sem isso, o timeout
// da plataforma deixaria a campanha presa em 'processing' (nunca reassumível)
// para sempre.
const TIME_BUDGET_MS = 15_000;

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
  for await (const batch of scanBatches(svc.entities.NotificationRecipient, { campaign_id: campaignId }, { pageSize: BATCH_SIZE })) {
    stats.queries++;
    for (const r of batch) {
      total++;
      if (r.delivery_status === "sent") sent++;
      else if (r.delivery_status === "failed") failed++;
      else pending++; // pending or processing
    }
  }
  return { total, sent, failed, pending };
}

// =============================================================================
// Main handler
// =============================================================================
export default async function(req: Request): Promise<Response> {
  // Estado do claim — usado no catch externo para REVERTER a campanha presa em
  // 'processing' para 'failed' (reassumível) em erro inesperado.
  let claimed = false;
  let claimedCampaignId = "";
  let svc: any = null;
  let phase1Incomplete = false;
  let phase2Incomplete = false;

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

    svc = base44.asServiceRole;

    // === Lock atômico da campanha (compare-and-swap em status) === da campanha (compare-and-swap em status) ===
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
    claimed = true;
    claimedCampaignId = campaign.id;
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
    //
    // Retomada de partially_sent PULA a resolução — os recipients já existem,
    // falta apenas a entrega (fase 2). Sem isso, cada rodada de retomada de uma
    // campanha grande re-resolveria a audiência inteira antes de entregar.
    // campaign.status é o status PRÉ-claim (registro lido antes do CAS).
    if (campaign.status !== 'partially_sent') {
      try {
        for await (const { recipients } of resolveAudienceBatches(svc, {
          scopeType: campaign.scope_type,
          scopeEventId: campaign.scope_event_id,
          audienceType: campaign.audience_type,
          audienceSegments: campaign.audience_payload ? JSON.parse(campaign.audience_payload) : [],
          senderUser: user,
          senderPartnerId,
        })) {
          // Orçamento esgotado no meio da resolução: encerra em 'failed'
          // (reassumível pelo claim). A dedup por $in da fase 1 torna a
          // re-resolução da próxima rodada idempotente — sem duplicatas.
          if (Date.now() - stats.startTime >= TIME_BUDGET_MS) {
            phase1Incomplete = true;
            break;
          }
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
      if (phase1Incomplete) {
        try {
          await svc.entities.NotificationCampaign.update(campaign.id, { status: "failed" });
          stats.queries++;
        } catch {}
        return Response.json({ ok: true, has_more: true, phase: 'resolution', stats });
      }
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
      // Orçamento esgotado com fila ainda cheia: encerra em 'partially_sent'
      // (reassumível; a próxima rodada pula a fase 1 e só entrega).
      if (Date.now() - stats.startTime >= TIME_BUDGET_MS) {
        phase2Incomplete = true;
        break;
      }
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
      has_more: phase2Incomplete,
      recipients_count: counts.total,
      delivered_count: counts.sent,
      failed_count: counts.failed,
      pending_count: counts.pending,
      stats,
    });
  } catch (error) {
    stats.totalTimeMs = Date.now() - stats.startTime;
    // Campanha presa em 'processing' NUNCA seria reassumida (o claim só aceita
    // draft/scheduled/partially_sent/failed). Erro inesperado após o claim →
    // reverte para 'failed' (retomável). Best-effort.
    if (claimed && svc && claimedCampaignId) {
      try {
        await svc.entities.NotificationCampaign.update(claimedCampaignId, { status: "failed" });
      } catch {}
    }
    return Response.json({ error: error.message, stats }, { status: 500 });
  }
}