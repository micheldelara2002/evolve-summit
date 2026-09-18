import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES, resolveUserPartnerManagerIds } from "../../shared/eventAuth.ts";
import { toCents } from "../../shared/commercePolicy.ts";
import {
  createConnectedAccount,
  createAccountLink,
  retrieveConnectedAccount,
  updateConnectedAccountPayoutSettings,
} from "../../shared/stripeClient.ts";

// Stripe Connect — o organizador do evento recebe as vendas direto na conta
// conectada dele (destination charge). A plataforma retém apenas a comissão
// (application fee). Contas Express pagam as taxas padrão do Stripe direto
// (Stripe-managed pricing). A plataforma nunca movimenta dinheiro do
// organizador — só recebe a comissão.
//
// Actions:
//   getEventPayout { eventId }                      — organizador: status da conta + comissão efetiva
//   startOnboarding { eventId, legal_name?, legal_document_number? } — cria/retoma conta + Account Link
//   refreshStatus { eventId }                       — sincroniza status com o Stripe + auto-vincula eventos
//   setReserve { eventId, amount }                   — reserva de saldo p/ estornos (gerida pelo Stripe)
//   getAdminConfig { eventId }                      — admin: contas + comissão + vinculação do evento
//   setPlatformCommission { percent }                — admin: comissão padrão da plataforma
//   setEventCommission { eventId, commission_percent } — admin: override por evento (null = herdar)
//   linkAccount { eventId, payout_account_id }       — admin: vincula/desvincula conta recebedora

const APP_URL = "https://evolve-summit.base44.app";

const REQUIREMENT_LABELS: Record<string, string> = {
  "external_account": "Dados bancários",
  "company.tax_id": "CNPJ da empresa",
  "company.name": "Razão social",
  "company.address": "Endereço da empresa",
  "company.phone": "Telefone da empresa",
  "business_profile.name": "Nome da empresa",
  "business_profile.url": "Site da empresa",
  "business_profile.mcc": "Ramo de atividade",
  "business_profile.product_description": "Descrição dos produtos/serviços",
  "relationship.representative": "Dados do representante legal",
  "relationship.owner": "Dados dos sócios",
  "relationship.account_opener": "Dados do titular da conta",
  "verification.document": "Documento de identificação (frente)",
  "verification.additional_document": "Documento de identificação complementar",
  "individual.verification.document": "Documento de identificação",
  "individual.id_number": "CPF do representante",
  "tos_acceptance": "Aceite dos termos do Stripe",
  "payment_statement_descriptor": "Descrição no extrato",
};

function humanizeRequirement(field: string): string {
  if (REQUIREMENT_LABELS[field]) return REQUIREMENT_LABELS[field];
  const last = field.split(".").pop() || field;
  return last.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// Mapeia a conta Stripe para o status interno.
function mapAccountStatus(acct: any): string {
  const disabled = String(acct?.requirements?.disabled_reason || "");
  if (disabled.includes("rejected")) return "rejected";
  if (acct?.charges_enabled) return "verified";
  const req = acct?.requirements || {};
  if ((req.past_due && req.past_due.length > 0) || disabled) return "restricted";
  return "pending";
}

// Sincroniza o snapshot da conta Stripe no registro local (PayoutAccount).
async function syncAccountFromStripe(svc: any, record: any): Promise<any> {
  const acct = await retrieveConnectedAccount(record.stripe_account_id);
  const req = acct?.requirements || {};
  return await svc.entities.PayoutAccount.update(record.id, {
    status: mapAccountStatus(acct),
    charges_enabled: !!acct?.charges_enabled,
    payouts_enabled: !!acct?.payouts_enabled,
    requirements_json: JSON.stringify({
      currently_due: req.currently_due || [],
      past_due: req.past_due || [],
      disabled_reason: req.disabled_reason || "",
    }),
  });
}

function sanitizeAccount(record: any): any {
  let req: any = {};
  try { req = JSON.parse(record.requirements_json || "{}"); } catch {}
  const due = [...(req.past_due || []), ...(req.currently_due || [])];
  return {
    id: record.id,
    legal_name: record.legal_name || "",
    legal_document_number: record.legal_document_number || "",
    status: record.status || "pending",
    charges_enabled: !!record.charges_enabled,
    payouts_enabled: !!record.payouts_enabled,
    reserve_amount: Number(record.reserve_amount) || 0,
    pending_requirements: [...new Set(due)].map(humanizeRequirement),
    disabled_reason: req.disabled_reason || "",
    manager_name: record.manager_name || "",
  };
}

async function getPlatformCommission(svc: any): Promise<number> {
  const rows = await svc.entities.PlatformSetting.filter({ key: "commission" });
  try {
    return Number(JSON.parse(rows[0]?.value_json || "{}").default_commission_percent) || 0;
  } catch {
    return 0;
  }
}

// Resolve a conta de recebimento do evento: conta vinculada ao evento, senão a
// conta do organizador (event.manager_id) — cobre o período entre o onboarding
// e o auto-vinculamento.
async function resolveEventAccount(svc: any, event: any): Promise<any | null> {
  if (event.payout_account_id) {
    const acct = (await svc.entities.PayoutAccount.filter({ id: event.payout_account_id, is_deleted: false }))[0];
    if (acct) return acct;
  }
  if (!event.manager_id) return null;
  const accts = await svc.entities.PayoutAccount.filter({ manager_user_id: event.manager_id, is_deleted: false });
  return accts[0] || null;
}

function commissionPayload(event: any, platformDefault: number) {
  const override = event.commission_percent != null ? Number(event.commission_percent) : null;
  return {
    platform_default: platformDefault,
    override,
    effective: override != null ? override : platformDefault,
  };
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const isAdmin = user.role === "admin";
    const svc = base44.asServiceRole;

    const body = await req.json().catch(() => ({}));
    const { action, eventId, legal_name, legal_document_number, percent, commission_percent, payout_account_id, amount } = body;

    if (!action) return Response.json({ error: "Ação obrigatória." }, { status: 400 });

    const loadEvent = async () => {
      const event = (await svc.entities.Event.filter({ id: eventId, is_deleted: false }))[0];
      if (!event) throw { status: 404, message: "Evento não encontrado." };
      return event;
    };
    const requireManager = async (ev: any) => {
      const auth = await verifyEventMembership(base44, user, ev.id, EVENT_MANAGER_ROLES);
      if (!auth.authorized) throw { status: 403, message: "Sem permissão para este evento." };
    };

    try {
      // ===== Organizador =====
      if (action === "getEventPayout") {
        if (!eventId) return Response.json({ error: "eventId obrigatório." }, { status: 400 });
        const event = await loadEvent();
        await requireManager(event);
        let account = await resolveEventAccount(svc, event);
        if (account?.stripe_account_id) {
          try { account = await syncAccountFromStripe(svc, account); } catch (err: any) {
            console.error("[managePayouts] sync failed:", err?.message || err);
          }
        }
        const platformDefault = await getPlatformCommission(svc);
        return Response.json({
          account: account ? sanitizeAccount(account) : null,
          commission: commissionPayload(event, platformDefault),
          event: { id: event.id, name: event.name, status: event.status, manager_name: event.manager_name || "" },
        });
      }

      if (action === "startOnboarding") {
        if (!eventId) return Response.json({ error: "eventId obrigatório." }, { status: 400 });
        const event = await loadEvent();
        await requireManager(event);
        const organizerId = event.manager_id || user.id;

        let account = (await svc.entities.PayoutAccount.filter({ manager_user_id: organizerId, is_deleted: false }))[0] || null;

        if (!account || !account.stripe_account_id) {
          // Prefill: dados enviados > empresa parceira do chamador > nome do gerente.
          let legalName = String(legal_name || "").trim();
          let docNumber = String(legal_document_number || "").replace(/\D/g, "");
          if (!legalName || !docNumber) {
            try {
              const partnerIds = await resolveUserPartnerManagerIds(base44, user);
              if (partnerIds.length > 0) {
                const partner = (await svc.entities.Partner.filter({ id: partnerIds[0], is_deleted: false }))[0];
                if (partner) {
                  legalName = legalName || partner.legal_name || partner.trade_name || "";
                  docNumber = docNumber || String(partner.legal_document_number || "").replace(/\D/g, "");
                }
              }
            } catch {}
          }
          if (!legalName) legalName = event.manager_name || user.full_name || "";
          if (!docNumber) {
            return Response.json({ error: "Informe o CNPJ da empresa organizadora." }, { status: 400 });
          }
          let organizerEmail = user.email || "";
          if (organizerId !== user.id) {
            const orgUser = (await svc.entities.User.filter({ id: organizerId }))[0];
            organizerEmail = orgUser?.email || user.email || "";
          }
          const stripeAccount = await createConnectedAccount({ email: organizerEmail, legalName });
          account = await svc.entities.PayoutAccount.create({
            manager_user_id: organizerId,
            manager_name: event.manager_name || user.full_name || "",
            legal_name: legalName,
            legal_document_number: docNumber,
            stripe_account_id: stripeAccount.id,
            status: "pending",
            charges_enabled: false,
            payouts_enabled: false,
            reserve_amount: 0,
            requirements_json: "",
            is_deleted: false,
          });
        }

        const returnUrl = `${APP_URL}/manage-event/${eventId}/payout?stripe_return=1`;
        const link = await createAccountLink({ accountId: account.stripe_account_id, refreshUrl: returnUrl, returnUrl });
        return Response.json({ url: link.url, account: sanitizeAccount(account) });
      }

      if (action === "refreshStatus") {
        if (!eventId) return Response.json({ error: "eventId obrigatório." }, { status: 400 });
        const event = await loadEvent();
        await requireManager(event);
        const account = await resolveEventAccount(svc, event);
        if (!account?.stripe_account_id) {
          return Response.json({ error: "Nenhuma conta conectada para este evento." }, { status: 404 });
        }
        let updated;
        try {
          updated = await syncAccountFromStripe(svc, account);
        } catch (err: any) {
          console.error("[managePayouts] refresh failed:", err?.message || err);
          return Response.json({ error: `Falha ao consultar o Stripe: ${err?.message || err}` }, { status: 502 });
        }
        // Auto-vincula os eventos do organizador que ainda não têm recebedor.
        if (updated.status === "verified") {
          try {
            await svc.entities.Event.updateMany(
              { manager_id: updated.manager_user_id, is_deleted: false, payout_account_id: { $in: [null, ""] } },
              { $set: { payout_account_id: updated.id } }
            );
          } catch {}
        }
        return Response.json({ account: sanitizeAccount(updated) });
      }

      if (action === "setReserve") {
        if (!eventId) return Response.json({ error: "eventId obrigatório." }, { status: 400 });
        const event = await loadEvent();
        await requireManager(event);
        const account = await resolveEventAccount(svc, event);
        if (!account?.stripe_account_id) {
          return Response.json({ error: "Nenhuma conta conectada para este evento." }, { status: 404 });
        }
        const reserveBRL = Math.max(0, Number(amount) || 0);
        try {
          await updateConnectedAccountPayoutSettings({
            accountId: account.stripe_account_id,
            minimumBalanceCents: toCents(reserveBRL),
            debitNegativeBalances: true,
          });
        } catch (err: any) {
          console.error("[managePayouts] reserve failed:", err?.message || err);
          return Response.json({ error: `Falha ao configurar a reserva no Stripe: ${err?.message || err}` }, { status: 502 });
        }
        const updated = await svc.entities.PayoutAccount.update(account.id, { reserve_amount: reserveBRL });
        return Response.json({ account: sanitizeAccount(updated) });
      }

      // ===== Admin =====
      if (action === "getAdminConfig") {
        if (!isAdmin) return Response.json({ error: "Sem permissão." }, { status: 403 });
        if (!eventId) return Response.json({ error: "eventId obrigatório." }, { status: 400 });
        const event = await loadEvent();
        const accounts = await svc.entities.PayoutAccount.filter({ is_deleted: false });
        const platformDefault = await getPlatformCommission(svc);
        let linked = event.payout_account_id ? (accounts.find((a: any) => a.id === event.payout_account_id) || null) : null;
        if (linked?.stripe_account_id) {
          try { linked = await syncAccountFromStripe(svc, linked); } catch {}
        }
        return Response.json({
          accounts: accounts.map(sanitizeAccount),
          linked: linked ? sanitizeAccount(linked) : null,
          commission: commissionPayload(event, platformDefault),
        });
      }

      if (action === "setPlatformCommission") {
        if (!isAdmin) return Response.json({ error: "Sem permissão." }, { status: 403 });
        const p = Math.min(100, Math.max(0, Number(percent) || 0));
        const existing = await svc.entities.PlatformSetting.filter({ key: "commission" });
        if (existing.length > 0) {
          await svc.entities.PlatformSetting.update(existing[0].id, { value_json: JSON.stringify({ default_commission_percent: p }) });
        } else {
          await svc.entities.PlatformSetting.create({ key: "commission", value_json: JSON.stringify({ default_commission_percent: p }) });
        }
        return Response.json({ ok: true, platform_default: p });
      }

      if (action === "setEventCommission") {
        if (!isAdmin) return Response.json({ error: "Sem permissão." }, { status: 403 });
        if (!eventId) return Response.json({ error: "eventId obrigatório." }, { status: 400 });
        await loadEvent();
        const hasOverride = commission_percent !== null && commission_percent !== undefined && commission_percent !== "";
        const value = hasOverride ? Math.min(100, Math.max(0, Number(commission_percent))) : null;
        await svc.entities.Event.update(eventId, { commission_percent: value });
        return Response.json({ ok: true, override: value });
      }

      if (action === "linkAccount") {
        if (!isAdmin) return Response.json({ error: "Sem permissão." }, { status: 403 });
        if (!eventId) return Response.json({ error: "eventId obrigatório." }, { status: 400 });
        await loadEvent();
        if (!payout_account_id) {
          await svc.entities.Event.update(eventId, { payout_account_id: "" });
          return Response.json({ ok: true, linked: null });
        }
        const acct = (await svc.entities.PayoutAccount.filter({ id: payout_account_id, is_deleted: false }))[0];
        if (!acct) return Response.json({ error: "Conta não encontrada." }, { status: 404 });
        await svc.entities.Event.update(eventId, { payout_account_id: acct.id });
        return Response.json({ ok: true, linked: sanitizeAccount(acct) });
      }

      return Response.json({ error: "Ação não suportada." }, { status: 400 });
    } catch (err: any) {
      if (err && typeof err.status === "number") {
        return Response.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  } catch (error: any) {
    console.error("[managePayouts]", error?.message || error);
    return Response.json({ error: error?.message || "Erro interno." }, { status: 500 });
  }
}