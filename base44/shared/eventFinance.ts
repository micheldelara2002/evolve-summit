// Fase 2 (2026-11-12) — acesso ÚNICO aos campos financeiros internos do evento.
//
// MOTIVO: `commission_percent`, `payout_account_id`, `refund_policy` e
// `coupon_codes_registry` viviam na entidade Event, cuja `read` é aberta a
// qualquer usuário autenticado para eventos ativos (RLS: status in
// [active, finished]). A plataforma não oferece regra de leitura por campo, e
// esconder campo no frontend não é proteção — então os campos migraram para
// EventFinance (RLS admin-only) e todo acesso de gestão passa por aqui, a partir
// de backend functions que já validam o vínculo com o evento e usam service role.
//
// COMPATIBILIDADE (janela de migração): enquanto `migrateEventFinance` não roda,
// o documento de EventFinance pode não existir e os valores legados continuam no
// Event. `withEventFinance` devolve o evento com os campos resolvidos das duas
// fontes, sem NUNCA escrever em leitura — nenhum fluxo quebra antes da migração.
//
// Depois da migração (valores legados esvaziados pela própria migração), a única
// fonte é o EventFinance.

export const EVENT_FINANCE_FIELDS = [
  'commission_percent',
  'payout_account_id',
  'refund_policy',
  'coupon_codes_registry',
] as const;

function hasValue(v: any): boolean {
  return v !== undefined && v !== null && v !== '';
}

// Normaliza o documento financeiro no formato que os consumidores já esperam.
function pickFinance(finance: any): any {
  return {
    commission_percent: hasValue(finance?.commission_percent) ? finance.commission_percent : null,
    payout_account_id: hasValue(finance?.payout_account_id) ? finance.payout_account_id : '',
    refund_policy: hasValue(finance?.refund_policy) ? finance.refund_policy : '',
    coupon_codes_registry: Array.isArray(finance?.coupon_codes_registry)
      ? finance.coupon_codes_registry
      : [],
  };
}

export async function getEventFinance(svc: any, eventId: string): Promise<any | null> {
  if (!eventId) return null;
  const rows = await svc.entities.EventFinance.filter({ event_id: eventId });
  return (rows && rows[0]) || null;
}

// Lê ou cria o documento (idempotente). Só é chamado por caminhos de ESCRITA:
// leitura nunca cria documento.
export async function ensureEventFinance(svc: any, eventId: string, legacyEvent?: any): Promise<any | null> {
  if (!eventId) return null;
  const existing = await getEventFinance(svc, eventId);
  if (existing) return existing;
  const event = legacyEvent || (await svc.entities.Event.filter({ id: eventId }))[0];
  try {
    return await svc.entities.EventFinance.create({
      event_id: eventId,
      commission_percent: hasValue(event?.commission_percent) ? event.commission_percent : null,
      payout_account_id: hasValue(event?.payout_account_id) ? event.payout_account_id : '',
      refund_policy: hasValue(event?.refund_policy) ? event.refund_policy : '',
      coupon_codes_registry: Array.isArray(event?.coupon_codes_registry)
        ? event.coupon_codes_registry
        : [],
    });
  } catch (err: any) {
    // Corrida na criação: outro caminho criou primeiro — relê.
    const raced = await getEventFinance(svc, eventId);
    if (raced) return raced;
    throw err;
  }
}

// Evento com os campos financeiros resolvidos (financeiro → legado). Nunca
// escreve: os chamadores continuam lendo `event.refund_policy` etc. como antes.
export async function withEventFinance(svc: any, event: any): Promise<any> {
  if (!event?.id) return event;
  let finance: any = null;
  try {
    finance = await getEventFinance(svc, event.id);
  } catch (err: any) {
    console.error('[eventFinance] finance read failed:', event.id, err?.message || err);
  }
  if (!finance) return event;
  const resolved = pickFinance(finance);
  return {
    ...event,
    commission_percent: resolved.commission_percent,
    payout_account_id: resolved.payout_account_id,
    refund_policy: resolved.refund_policy,
    coupon_codes_registry: resolved.coupon_codes_registry,
  };
}

// Escrita dos campos financeiros (service role). Cria o documento se ainda não
// existir, para que o primeiro gestor a configurar não dependa da migração.
export async function patchEventFinance(svc: any, eventId: string, patch: any): Promise<any> {
  const doc = await ensureEventFinance(svc, eventId);
  if (!doc) throw new Error('Configuração financeira do evento não encontrada.');
  const clean: any = {};
  for (const key of EVENT_FINANCE_FIELDS) {
    if (patch[key] !== undefined) clean[key] = patch[key];
  }
  if (Object.keys(clean).length > 0) {
    await svc.entities.EventFinance.update(doc.id, clean);
  }
  return { ...doc, ...clean };
}

// ===== DAT-001 — registro de códigos de cupom (claim atômico) =====
//
// A unicidade concorrente é preservada: o CAS ($ne + $push) roda no MESMO
// documento (EventFinance do evento), então continua havendo exatamente um
// vencedor por código em corrida — a primitiva não mudou, só o documento.

export function normalizeCouponCode(code: any): string {
  return String(code || '').trim().toUpperCase();
}

export async function backfillCouponRegistry(svc: any, eventId: string): Promise<void> {
  const doc = await ensureEventFinance(svc, eventId);
  if (!doc) return;
  const active = await svc.entities.Coupon.filter({ event_id: eventId, is_deleted: false });
  for (const c of active) {
    const nc = normalizeCouponCode(c.code);
    if (!nc) continue;
    try {
      await svc.entities.EventFinance.updateMany(
        { id: doc.id, coupon_codes_registry: { $ne: nc } },
        { $push: { coupon_codes_registry: nc } },
      );
    } catch {}
  }
}

export async function claimCouponCode(svc: any, eventId: string, code: string): Promise<boolean> {
  const doc = await ensureEventFinance(svc, eventId);
  if (!doc) return false;
  await backfillCouponRegistry(svc, eventId);
  const claim = await svc.entities.EventFinance.updateMany(
    { id: doc.id, coupon_codes_registry: { $ne: code } },
    { $push: { coupon_codes_registry: code } },
  );
  return !!(claim && claim.updated);
}

export async function releaseCouponCode(svc: any, eventId: string, code: string): Promise<void> {
  if (!code) return;
  const others = await svc.entities.Coupon.filter({ event_id: eventId, code, is_deleted: false });
  if (others.length > 0) return;
  const doc = await getEventFinance(svc, eventId);
  if (!doc) return;
  try {
    await svc.entities.EventFinance.updateMany(
      { id: doc.id },
      { $pull: { coupon_codes_registry: code } },
    );
  } catch {}
}