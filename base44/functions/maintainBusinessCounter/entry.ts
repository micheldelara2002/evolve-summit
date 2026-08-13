import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import {
  incUniqueParticipant, decUniqueParticipant,
  incParticipantsByRole, decParticipantsByRole, moveParticipantsByRole,
  incLeads, incUsers, incPersons, incPartners, decPartners,
} from "../../shared/businessMetrics.ts";

// P0.3 — Ponto único de manutenção dos counters materializados (EventStats/MetricBucket)
// chamado pelo frontend após mutations de Participant/Lead/Person/Partner e pelo workflow
// app_user_auth:signup (incUsers). Best-effort: a mutation principal já sucedeu; falha aqui
// não bloqueia — reconcile corrige drift.
//
// Ações:
//   incParticipant        { eventId, createdDateISO, role? }            — unique + participants_by_role
//   decParticipant        { eventId, createdDateISO, role? }            — unique + participants_by_role
//   bulkIncParticipants   { eventId, createdDates: [iso], roles?: [str] } — unique + by_role por item
//   moveParticipantRole   { eventId, createdDateISO, oldRole, newRole } — dec old role, inc new role (unique não muda)
//   incLeads             { eventId, partnerId?, createdDateISO, count? }
//   incUsers              { createdDateISO }                            — bucket global users
//   incPersons            { createdDateISO }                            — bucket global persons
//   incPartners           { createdDateISO }                            — bucket global partners
//   decPartners           { createdDateISO }                            — soft-delete de Partner

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = base44.asServiceRole;
    const body = await req.json();
    const { action } = body;

    if (action === 'incParticipant') {
      const { eventId, createdDateISO, role } = body;
      if (!eventId || !createdDateISO) return Response.json({ error: 'eventId e createdDateISO obrigatórios' }, { status: 400 });
      await incUniqueParticipant(svc, eventId, createdDateISO);
      if (role) await incParticipantsByRole(svc, eventId, role, createdDateISO);
      return Response.json({ ok: true });
    }
    if (action === 'decParticipant') {
      const { eventId, createdDateISO, role } = body;
      if (!eventId || !createdDateISO) return Response.json({ error: 'eventId e createdDateISO obrigatórios' }, { status: 400 });
      await decUniqueParticipant(svc, eventId, createdDateISO);
      if (role) await decParticipantsByRole(svc, eventId, role, createdDateISO);
      return Response.json({ ok: true });
    }
    if (action === 'bulkIncParticipants') {
      const { eventId, createdDates, roles } = body;
      if (!eventId || !Array.isArray(createdDates)) return Response.json({ error: 'eventId e createdDates[] obrigatórios' }, { status: 400 });
      for (let i = 0; i < createdDates.length; i++) {
        const iso = createdDates[i];
        if (!iso) continue;
        await incUniqueParticipant(svc, eventId, iso);
        const role = roles && roles[i];
        if (role) await incParticipantsByRole(svc, eventId, role, iso);
      }
      return Response.json({ ok: true, count: createdDates.length });
    }
    if (action === 'moveParticipantRole') {
      const { eventId, createdDateISO, oldRole, newRole } = body;
      if (!eventId || !createdDateISO) return Response.json({ error: 'eventId e createdDateISO obrigatórios' }, { status: 400 });
      await moveParticipantsByRole(svc, eventId, oldRole, newRole, createdDateISO);
      return Response.json({ ok: true });
    }
    if (action === 'incLeads') {
      const { eventId, partnerId, createdDateISO, count } = body;
      if (!eventId || !createdDateISO) return Response.json({ error: 'eventId e createdDateISO obrigatórios' }, { status: 400 });
      await incLeads(svc, eventId, partnerId || '', createdDateISO, count || 1);
      return Response.json({ ok: true });
    }
    if (action === 'incUsers') {
      const { createdDateISO } = body;
      if (!createdDateISO) return Response.json({ error: 'createdDateISO obrigatório' }, { status: 400 });
      await incUsers(svc, createdDateISO);
      // P0.3 — popula created_day no User para correção de borda do dashboard (equality query).
      // User é criado pelo auth (platform-owned); este handler (chamado pelo workflow de signup)
      // é o único hook pós-signup. Best-effort: reconcileGlobalMetrics faz backfill se falhar.
      try {
        const dk = new Date(createdDateISO).toISOString().slice(0, 10);
        await svc.entities.User.update(user.id, { created_day: dk });
      } catch {}
      return Response.json({ ok: true });
    }
    if (action === 'incPersons') {
      const { createdDateISO } = body;
      if (!createdDateISO) return Response.json({ error: 'createdDateISO obrigatório' }, { status: 400 });
      await incPersons(svc, createdDateISO);
      return Response.json({ ok: true });
    }
    if (action === 'incPartners') {
      const { createdDateISO } = body;
      if (!createdDateISO) return Response.json({ error: 'createdDateISO obrigatório' }, { status: 400 });
      await incPartners(svc, createdDateISO);
      return Response.json({ ok: true });
    }
    if (action === 'decPartners') {
      const { createdDateISO } = body;
      if (!createdDateISO) return Response.json({ error: 'createdDateISO obrigatório' }, { status: 400 });
      await decPartners(svc, createdDateISO);
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'action inválido' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});