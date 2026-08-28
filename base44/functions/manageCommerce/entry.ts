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
      return Response.json({ policy, global: DEFAULT_GLOBAL_REFUND_POLICY, override });
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
      return Response.json({ records });
    }

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