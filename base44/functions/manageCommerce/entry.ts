import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";
import { resolveRefundPolicy, DEFAULT_GLOBAL_REFUND_POLICY } from "../../shared/commercePolicy.ts";

// Admin/event-manager commerce config CRUD.
// Entities managed: TicketType, SalesLot, Coupon, and per-event refund policy override
// (stored on the event-level CommerceConfig record inside manageEventConfig).
//
// Actions: list, create, update, delete (soft), getPolicy, setPolicy, getGlobalPolicy.
// Manager auth: event manager/team or global admin (verifyEventMembership).

const ENTITY_SET = new Set(['TicketType', 'SalesLot', 'Coupon']);

const SANITIZE = {
  TicketType: ['name', 'description', 'sort_order', 'is_active'],
  SalesLot: ['ticket_type_id', 'name', 'price', 'currency', 'sale_start', 'sale_end', 'quantity_total', 'is_active'],
  Coupon: ['code', 'discount_type', 'value', 'scope', 'valid_from', 'valid_to', 'max_uses', 'is_active'],
};

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
      // global default from app config (EventConfig) — best-effort
      let global = DEFAULT_GLOBAL_REFUND_POLICY;
      try {
        const cfg = await svc.entities.EventConfig.filter({ key: 'global_refund_policy' });
        if (cfg[0]?.value) global = { ...DEFAULT_GLOBAL_REFUND_POLICY, ...cfg[0].value };
      } catch {}
      // event override
      let override: any = null;
      try {
        const evCfg = await svc.entities.EventConfig.filter({ event_id: eventId, key: 'commerce_refund_policy' });
        override = evCfg[0]?.value || null;
      } catch {}
      const policy = resolveRefundPolicy(override, { refund_policy: global });
      return Response.json({ policy, global, override });
    }

    if (action === 'setPolicy') {
      if (!eventId) return Response.json({ error: 'eventId obrigatório.' }, { status: 400 });
      const managerAuth = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
      if (!managerAuth.authorized) return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      try {
        const existing = await svc.entities.EventConfig.filter({ event_id: eventId, key: 'commerce_refund_policy' });
        if (existing[0]) {
          await svc.entities.EventConfig.update(existing[0].id, { value: data });
        } else {
          await svc.entities.EventConfig.create({ event_id: eventId, key: 'commerce_refund_policy', value: data });
        }
      } catch {
        return Response.json({ error: 'Falha ao salvar política (EventConfig indisponível).' }, { status: 500 });
      }
      return Response.json({ ok: true, policy: data });
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
      return Response.json({ records });
    }

    // All mutations require manager/admin.
    if (!authorized) return Response.json({ error: 'Sem permissão.' }, { status: 403 });

    if (action === 'create') {
      const clean: any = { event_id: eventId };
      for (const k of SANITIZE[entityName]) if (k in data) clean[k] = data[k];
      if (entityName === 'Coupon' && clean.code) clean.code = String(clean.code).toUpperCase().trim();
      const record = await svc.entities[entityName].create(clean);
      return Response.json({ record });
    }

    if (action === 'update') {
      if (!id) return Response.json({ error: 'id obrigatório.' }, { status: 400 });
      const existing = await svc.entities[entityName].filter({ id, event_id: eventId });
      if (!existing.length) return Response.json({ error: 'Registro não encontrado.' }, { status: 404 });
      const clean: any = {};
      for (const k of SANITIZE[entityName]) if (k in data) clean[k] = data[k];
      delete clean.is_deleted;
      if (entityName === 'Coupon' && clean.code) clean.code = String(clean.code).toUpperCase().trim();
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