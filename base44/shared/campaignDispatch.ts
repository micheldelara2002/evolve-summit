// P2 (2026-09-29) — Núcleo de disparo de campanhas (shared). Fonte ÚNICA do fluxo
// claim CAS → resolução de audiência → entrega in-app → contagem final, usada por:
//   - dispatchNotificationCampaign (envio manual autenticado — permissão
//     validada no momento do envio, com o usuário logado);
//   - varredura de manutenção (expireStaleReservations) para campanhas
//     'scheduled' vencidas e retomadas de disparos automáticos — permissão
//     CONFIADA no agendamento (regra aprovada), sem revalidação de membership.
//
// SEMÂNTICAS (herdadas do dispatchNotificationCampaign original — ver header
// histórico lá): recipient_user_id é SEMPRE User ID; entrega em 4 fases
// (pending → processing → sent/failed); "sent" é terminal; orçamento de tempo
// por invocação com encerramento REASSUMÍVEL ('failed' durante a resolução,
// 'partially_sent' durante a entrega) — o chamador encadeia novas rodadas.
import { scanBatches } from "./completeScan.ts";
import { resolveAudienceBatches, AUDIENCE_BATCH_SIZE as BATCH_SIZE } from "./campaignAudience.ts";

export const CAMPAIGN_TIME_BUDGET_MS = 15_000;

type Recipient = { user_id: string; name: string; email: string; role: string };

// =============================================================================
// Process a batch: within-batch dedup by user_id → cross-batch dedup via $in →
// bulkCreate as "pending" (not yet visible in inbox).
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
// Core: claim atômico (CAS em status) → fase 1 (resolução) → fase 2 (entrega)
// → contagem final + update da campanha. Erro inesperado após o claim reverte
// para 'failed' (retomável) — nunca deixa a campanha presa em 'processing'.
//
// Resultado:
//   { ok: false, claimed: false }        → claim perdido (já em andamento/concluída)
//   { ok: false, claimed: true, error }  → falha NÃO reassumível (fase 1/inesperada)
//   { ok: true, has_more: true }        → rodada encerrada por orçamento, reassumível
//   { ok: true, has_more: false, ... }   → dispatch concluído (sent/partially_sent)
// =============================================================================
export async function dispatchCampaignCore(
  svc: any,
  opts: {
    campaign: any;
    senderUser: any;
    senderPartnerId?: string | null;
    auditUserId: string;
    timeBudgetMs?: number;
  }
): Promise<any> {
  const campaign = opts.campaign;
  const timeBudgetMs = opts.timeBudgetMs || CAMPAIGN_TIME_BUDGET_MS;
  let claimed = false;
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

  // === Lock atômico da campanha (compare-and-swap em status) ===
  // Só um worker consegue virar status para "processing" a partir de
  // draft/scheduled (novo envio) ou partially_sent/failed (retry de
  // pendentes). Concorrentes recebem claimed=false.
  const claim = await svc.entities.NotificationCampaign.updateMany(
    { id: campaign.id, status: { $in: ["draft", "scheduled", "partially_sent", "failed"] } },
    { $set: { status: "processing" } }
  );
  stats.queries++;
  if (!claim || !claim.updated) {
    return { ok: false, claimed: false, error: "Envio já em andamento ou já concluído." };
  }
  claimed = true;

  try {
    // Auditoria da assunção do lock: quem assumiu o envio e quando.
    try {
      await svc.entities.AuditLog.create({
        action: 'status_change',
        entity_type: 'NotificationCampaign',
        entity_id: campaign.id,
        details: JSON.stringify({ type: 'dispatch_lock_acquired' }),
        event_id: campaign.scope_event_id || '',
        user_id: opts.auditUserId,
      });
      stats.queries++;
    } catch {}

    // === Phase 1: Resolve audience + create recipients as "pending" ===
    // Retomada de partially_sent PULA a resolução — os recipients já existem,
    // falta apenas a entrega. campaign.status é o status PRÉ-claim.
    if (campaign.status !== 'partially_sent') {
      try {
        for await (const { recipients } of resolveAudienceBatches(svc, {
          scopeType: campaign.scope_type,
          scopeEventId: campaign.scope_event_id,
          audienceType: campaign.audience_type,
          audienceSegments: campaign.audience_payload ? JSON.parse(campaign.audience_payload) : [],
          senderUser: opts.senderUser,
          senderPartnerId: opts.senderPartnerId ?? null,
        })) {
          // Orçamento esgotado no meio da resolução: encerra em 'failed'
          // (reassumível pelo claim). A dedup por $in da fase 1 torna a
          // re-resolução da próxima rodada idempotente — sem duplicatas.
          if (Date.now() - stats.startTime >= timeBudgetMs) {
            try {
              await svc.entities.NotificationCampaign.update(campaign.id, { status: "failed" });
              stats.queries++;
            } catch {}
            return { ok: true, claimed: true, has_more: true, phase: 'resolution', stats };
          }
          await processRecipientBatch(svc, campaign.id, recipients, stats);
        }
      } catch (e: any) {
        await svc.entities.NotificationCampaign.update(campaign.id, { status: "failed" });
        stats.queries++;
        return { ok: false, claimed: true, error: 'Falha ao resolver destinatários: ' + e.message, stats };
      }
    }

    // === Phase 2: Materialize in-app — process pending/processing/failed → sent ===
    // bulkUpdate to "sent" makes the notification visible in the recipient's
    // NotificationInbox (which filters by delivery_status: "sent").
    // Query always starts at skip=0: processed records leave the result set.
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

      await svc.entities.NotificationRecipient.bulkUpdate(
        batch.map((r: any) => ({ id: r.id, delivery_status: "processing" }))
      );
      stats.queries++;

      try {
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
      if (Date.now() - stats.startTime >= timeBudgetMs) {
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

    return {
      ok: true,
      claimed: true,
      has_more: phase2Incomplete,
      recipients_count: counts.total,
      delivered_count: counts.sent,
      failed_count: counts.failed,
      pending_count: counts.pending,
      stats,
    };
  } catch (error: any) {
    stats.totalTimeMs = Date.now() - stats.startTime;
    // Campanha presa em 'processing' NUNCA seria reassumida (o claim só aceita
    // draft/scheduled/partially_sent/failed). Erro inesperado após o claim →
    // reverte para 'failed' (retomável). Best-effort.
    if (claimed) {
      try {
        await svc.entities.NotificationCampaign.update(campaign.id, { status: "failed" });
      } catch {}
    }
    return { ok: false, claimed: true, error: error?.message || String(error), stats };
  }
}