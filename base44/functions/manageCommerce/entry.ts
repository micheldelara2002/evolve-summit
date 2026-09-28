import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";
import { resolveRefundPolicy, DEFAULT_GLOBAL_REFUND_POLICY } from "../../shared/commercePolicy.ts";

// Admin/event-manager commerce config CRUD.
// Entities managed: TicketType, SalesLot, Coupon.
// Refund policy: stored as JSON on the Event entity (refund_policy field), override of global default.
//
// Actions: list, create, update, delete (soft), getPolicy, setPolicy, getGlobalPolicy.

const ENTITY_SET = new Set(['TicketType', 'SalesLot', 'Coupon']);

const SANITIZE = {
  TicketType: ['name', 'description', 'sort_order', 'is_active'],
  SalesLot: ['ticket_type_id', 'name', 'price', 'currency', 'sale_start', 'sale_end', 'quantity_total', 'is_active'],
  Coupon: ['code', 'discount_type', 'value', 'scope', 'valid_from', 'valid_to', 'max_uses', 'is_active'],
};

// DAT-001 — normalização lógica do código do cupom (mesma regra aplicada no
// checkout): maiúsculas, sem espaços nas bordas.
function normalizeCouponCode(code: any): string {
  return String(code || '').trim().toUpperCase();
}

// DAT-001 — unicidade de código por evento: retorna duplicados ativos
// (excluindo o próprio id, quando informado).
async function findDuplicateCouponCodes(svc: any, eventId: string, code: string, excludeId?: string): Promise<any[]> {
  const rows = await svc.entities.Coupon.filter({ event_id: eventId, code, is_deleted: false });
  return rows.filter((r: any) => r.id !== excludeId);
}

function parseOverride(event: any): any {
  if (!event?.refund_policy) return null;
  try { return JSON.parse(event.refund_policy); } catch { return null; }
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;

    const body = await req.json();
    const { action, entityName, eventId, id, data = {} } = body;

    // ===== Refund policy (per-event override + global default) =====
    if (action === 'getPolicy') {
      if (!eventId) return Response.json({ error: 'eventId obrigatório.' }, { status: 400 });
      const event = (await svc.entities.Event.filter({ id: eventId }))[0];
      const override = parseOverride(event);
      const policy = resolveRefundPolicy(override, { refund_policy: DEFAULT_GLOBAL_REFUND_POLICY });
      // event_start: usado pelo checkout para informar as janelas de estorno ao comprador.
      return Response.json({ policy, global: DEFAULT_GLOBAL_REFUND_POLICY, override, event_start: event?.start_date || '' });
    }

    if (action === 'setPolicy') {
      if (!eventId) return Response.json({ error: 'eventId obrigatório.' }, { status: 400 });
      const managerAuth = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
      if (!managerAuth.authorized && user.role !== 'admin') return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      const event = (await svc.entities.Event.filter({ id: eventId }))[0];
      await svc.entities.Event.update(eventId, { refund_policy: JSON.stringify(data) });
      const policy = resolveRefundPolicy(data, { refund_policy: DEFAULT_GLOBAL_REFUND_POLICY });
      return Response.json({ ok: true, policy });
    }

    if (action === 'setRequiresPayment') {
      if (!eventId) return Response.json({ error: 'eventId obrigatório.' }, { status: 400 });
      const managerAuth = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
      if (!managerAuth.authorized && user.role !== 'admin') return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      await svc.entities.Event.update(eventId, { requires_payment: !!data.requires_payment });
      return Response.json({ ok: true, requires_payment: !!data.requires_payment });
    }

    // ===== Entity CRUD =====
    if (!entityName || !ENTITY_SET.has(entityName)) {
      return Response.json({ error: 'Entidade não permitida.' }, { status: 400 });
    }
    if (!eventId) return Response.json({ error: 'eventId obrigatório.' }, { status: 400 });

    const isAdmin = user.role === 'admin';
    const managerAuth = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
    const authorized = isAdmin || managerAuth.authorized;

    if (action === 'list') {
      if (!authorized) return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      const filter: any = { event_id: eventId };
      if (!id) filter.is_deleted = false;
      if (id) filter.id = id;
      const records = await svc.entities[entityName].filter(filter);
      // DAT-001 — diagnóstico de códigos duplicados LEGADOS (somente sinaliza,
      // nunca apaga): grupos de código com mais de um cupom ativo no evento.
      let duplicate_codes: any[] = [];
      if (entityName === 'Coupon') {
        const byCode = new Map<string, any[]>();
        for (const r of records) {
          if (!r.code || r.is_deleted) continue;
          const code = normalizeCouponCode(r.code);
          byCode.set(code, [...(byCode.get(code) || []), r]);
        }
        duplicate_codes = Array.from(byCode.entries())
          .filter(([, group]) => group.length > 1)
          .map(([code, group]) => ({ code, ids: group.map((g: any) => g.id) }));
      }
      return Response.json({ records, duplicate_codes });
    }

    if (!authorized) return Response.json({ error: 'Sem permissão.' }, { status: 403 });

    if (action === 'create') {
      const clean: any = { event_id: eventId };
      for (const k of SANITIZE[entityName]) if (k in data) clean[k] = data[k];
      if (entityName === 'Coupon' && clean.code) clean.code = normalizeCouponCode(clean.code);
      // DAT-001 — unicidade de código por evento no create.
      if (entityName === 'Coupon' && clean.code) {
        const dups = await findDuplicateCouponCodes(svc, eventId, clean.code);
        if (dups.length > 0) {
          return Response.json({ error: `Já existe um cupom com o código "${clean.code}" neste evento.` }, { status: 409 });
        }
      }
      const record = await svc.entities[entityName].create(clean);
      // DAT-001 — concorrência no create: re-checa pós-create. Duplicata
      // concorrente → a própria criação é desfeita (soft delete) e o chamador
      // recebe conflito controlado.
      if (entityName === 'Coupon' && clean.code) {
        const dups = await findDuplicateCouponCodes(svc, eventId, clean.code, record.id);
        if (dups.length > 0) {
          try { await svc.entities.Coupon.update(record.id, { is_deleted: true }); } catch {}
          return Response.json({ error: `Já existe um cupom com o código "${clean.code}" neste evento.` }, { status: 409 });
        }
      }
      return Response.json({ record });
    }

    if (action === 'update') {
      if (!id) return Response.json({ error: 'id obrigatório.' }, { status: 400 });
      const existing = await svc.entities[entityName].filter({ id, event_id: eventId });
      if (!existing.length) return Response.json({ error: 'Registro não encontrado.' }, { status: 404 });
      const clean: any = {};
      for (const k of SANITIZE[entityName]) if (k in data) clean[k] = data[k];
      delete clean.is_deleted;
      if (entityName === 'Coupon' && clean.code) clean.code = normalizeCouponCode(clean.code);
      // DAT-001 — unicidade de código por evento no update (exclui o próprio).
      if (entityName === 'Coupon' && clean.code) {
        const dups = await findDuplicateCouponCodes(svc, eventId, clean.code, id);
        if (dups.length > 0) {
          return Response.json({ error: `Já existe um cupom com o código "${clean.code}" neste evento.` }, { status: 409 });
        }
      }
      const record = await svc.entities[entityName].update(id, clean);
      return Response.json({ record });
    }

    if (action === 'delete') {
      if (!id) return Response.json({ error: 'id obrigatório.' }, { status: 400 });
      const existing = await svc.entities[entityName].filter({ id, event_id: eventId });
      if (!existing.length) return Response.json({ error: 'Registro não encontrado.' }, { status: 404 });
      const record = await svc.entities[entityName].update(id, { is_deleted: true, is_active: false });
      return Response.json({ record });
    }

    return Response.json({ error: 'Ação não suportada.' }, { status: 400 });
  } catch (error: any) {
    console.error('[manageCommerce]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}