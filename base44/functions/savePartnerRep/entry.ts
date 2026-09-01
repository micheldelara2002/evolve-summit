import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { canManagePartnerData } from "../../shared/eventAuth.ts";

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json();
    const { id, action, partnerId, personId, roleInPartner, isPrimary, isActive, payload } = body;

    // Helper: mutual-exclusão do is_primary dentro do parceiro
    const clearOtherPrimaries = async (pid, exceptId) => {
      const others = await base44.asServiceRole.entities.PartnerRepresentative.filter({
        partner_id: pid,
        is_primary: true,
        is_active: true,
        is_deleted: false,
      });
      await Promise.all(
        others.filter((r) => r.id !== exceptId).map((r) => base44.asServiceRole.entities.PartnerRepresentative.update(r.id, { is_primary: false }))
      );
    };

    // DELETE — soft delete
    if (action === 'delete' && id) {
      const reps = await base44.asServiceRole.entities.PartnerRepresentative.filter({ id });
      const rep = reps?.[0];
      if (!rep) return Response.json({ error: 'Representante não encontrado.' }, { status: 404 });
      const ok = await canManagePartnerData(base44, user, rep.partner_id);
      if (!ok) return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      await base44.asServiceRole.entities.PartnerRepresentative.update(id, { is_deleted: true });
      return Response.json({ ok: true, id });
    }

    // SET PRIMARY
    if (action === 'setPrimary' && id) {
      const reps = await base44.asServiceRole.entities.PartnerRepresentative.filter({ id, is_deleted: false });
      const rep = reps?.[0];
      if (!rep) return Response.json({ error: 'Representante não encontrado.' }, { status: 404 });
      const ok = await canManagePartnerData(base44, user, rep.partner_id);
      if (!ok) return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      await clearOtherPrimaries(rep.partner_id, id);
      await base44.asServiceRole.entities.PartnerRepresentative.update(id, { is_primary: true, is_active: true });
      return Response.json({ ok: true, id });
    }

    // UPDATE
    if (id) {
      const reps = await base44.asServiceRole.entities.PartnerRepresentative.filter({ id, is_deleted: false });
      const rep = reps?.[0];
      if (!rep) return Response.json({ error: 'Representante não encontrado.' }, { status: 404 });
      const ok = await canManagePartnerData(base44, user, rep.partner_id);
      if (!ok) return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      const p = payload || {};
      const clean = {};
      if (p.is_active !== undefined) clean.is_active = !!p.is_active;
      if (p.is_primary !== undefined) {
        clean.is_primary = !!p.is_primary;
        if (p.is_primary) await clearOtherPrimaries(rep.partner_id, id);
      }
      if (p.role_in_partner !== undefined) clean.role_in_partner = p.role_in_partner;
      await base44.asServiceRole.entities.PartnerRepresentative.update(id, clean);
      return Response.json({ ok: true, id });
    }

    // CREATE
    if (!partnerId || !personId || !roleInPartner) {
      return Response.json({ error: 'partnerId, personId e roleInPartner são obrigatórios.' }, { status: 400 });
    }
    const ok = await canManagePartnerData(base44, user, partnerId);
    if (!ok) return Response.json({ error: 'Sem permissão para gerenciar representantes deste parceiro.' }, { status: 403 });
    if (isPrimary) await clearOtherPrimaries(partnerId, null);
    const created = await base44.asServiceRole.entities.PartnerRepresentative.create({
      partner_id: partnerId,
      person_id: personId,
      role_in_partner: roleInPartner,
      is_primary: !!isPrimary,
      is_active: isActive !== false,
    });
    return Response.json({ ok: true, id: created.id });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});