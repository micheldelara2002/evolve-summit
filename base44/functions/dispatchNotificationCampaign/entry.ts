// =============================================================================
// NotificationCampaign — Envio manual autenticado
// =============================================================================
//
// O fluxo de disparo (claim CAS → resolução → entrega → contagem) vive em
// shared/campaignDispatch.ts (fonte ÚNICA — P2 2026-09-29), também usada pela
// varredura de manutenção para campanhas AGENDADAS (service role, permissão
// confiada no agendamento). Este handler é responsável apenas por:
//   1. Autenticar o usuário ativo;
//   2. Buscar a campanha no banco (não confia no payload do cliente);
//   3. Validar a AUTORIZAÇÃO do emissor (membership/papéis — mesmo conjunto de
//      regras do agendamento e da contagem de audiência);
//   4. Invocar o núcleo e mapear o resultado para o contrato HTTP do frontend
//      (dispatchCampaign encadeia rodadas com base em has_more).
//
// Garantias de concorrência/entrega: ver header de shared/campaignDispatch.ts.
// =============================================================================
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyCampaignSenderAuthorization } from "../../shared/campaignAuth.ts";
import { dispatchCampaignCore, CAMPAIGN_TIME_BUDGET_MS } from "../../shared/campaignDispatch.ts";

export default async function(req: Request): Promise<Response> {
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

    // === Authorization — verificador compartilhado (campaignAuth) ===
    // P0 (2026-10-17): mesmo conjunto de regras do agendamento e do disparo
    // AGENDADO — revalida emissor, estado da conta e membership ATUAIS no
    // disparo (a permissão do agendamento não substitui a validação).
    const verdict = await verifyCampaignSenderAuthorization(base44, user, campaign, senderPartnerId || null);
    if (!verdict.authorized) {
      return Response.json({ error: 'Sem permissão para enviar esta campanha.' }, { status: 403 });
    }

    const svc = base44.asServiceRole;

    // Núcleo compartilhado (claim CAS + fases + contagem + reversão de erro).
    const result = await dispatchCampaignCore(svc, {
      campaign,
      senderUser: user,
      senderPartnerId,
      auditUserId: user.id,
      timeBudgetMs: CAMPAIGN_TIME_BUDGET_MS,
    });

    if (!result.ok && !result.claimed) {
      // Claim perdido — outro dispatcher/manual/agendado está no comando.
      return Response.json({ error: result.error }, { status: 409 });
    }
    if (!result.ok) {
      return Response.json({ ok: false, error: result.error, stats: result.stats }, { status: 500 });
    }
    return Response.json({
      ok: true,
      has_more: result.has_more,
      recipients_count: result.recipients_count,
      delivered_count: result.delivered_count,
      failed_count: result.failed_count,
      pending_count: result.pending_count,
      stats: result.stats,
    });
  } catch (error: any) {
    console.error('[dispatchNotificationCampaign]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}