import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";
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
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;
    const body = await req.json();
    const { action } = body;

    const requireEventManager = async (eventId) => {
      const auth = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
      if (!auth.authorized) {
        return Response.json({ error: 'Sem permissão para manter métricas deste evento.' }, { status: 403 });
      }
      return null;
    };

    if (action === 'incParticipant') {
      const { eventId, createdDateISO, role } = body;
      if (!eventId || !createdDateISO) return Response.json({ error: 'eventId e createdDateISO obrigatórios' }, { status: 400 });
      const forbidden = await requireEventManager(eventId); if (forbidden) return forbidden;
      await incUniqueParticipant(svc, eventId, createdDateISO);
      if (role) await incParticipantsByRole(svc, eventId, role, createdDateISO);
      return Response.json({ ok: true });
    }
    if (action === 'decParticipant') {
      const { eventId, createdDateISO, role } = body;
      if (!eventId || !createdDateISO) return Response.json({ error: 'eventId e createdDateISO obrigatórios' }, { status: 400 });
      const forbidden = await requireEventManager(eventId); if (forbidden) return forbidden;
      await decUniqueParticipant(svc, eventId, createdDateISO);
      if (role) await decParticipantsByRole(svc, eventId, role, createdDateISO);
      return Response.json({ ok: true });
    }
    if (action === 'bulkIncParticipants') {
      const { eventId, createdDates, roles } = body;
      if (!eventId || !Array.isArray(createdDates)) return Response.json({ error: 'eventId e createdDates[] obrigatórios' }, { status: 400 });
      if (createdDates.length > 500) return Response.json({ error: 'createdDates excede o limite de 500 itens.' }, { status: 400 });
      const forbidden = await requireEventManager(eventId); if (forbidden) return forbidden;
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
      const forbidden = await requireEventManager(eventId); if (forbidden) return forbidden;
      if (!oldRole || !newRole || oldRole === newRole) return Response.json({ error: 'oldRole e newRole válidos e diferentes são obrigatórios' }, { status: 400 });
      await moveParticipantsByRole(svc, eventId, oldRole, newRole, createdDateISO);
      return Response.json({ ok: true });
    }
    if (action === 'incLeads') {
      const { eventId, partnerId, createdDateISO, count } = body;
      if (!eventId || !createdDateISO) return Response.json({ error: 'eventId e createdDateISO obrigatórios' }, { status: 400 });
      const forbidden = await requireEventManager(eventId); if (forbidden) return forbidden;
      if (count !== undefined && (!Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 500)) return Response.json({ error: 'count deve ser um inteiro entre 1 e 500.' }, { status: 400 });
      await incLeads(svc, eventId, partnerId || '', createdDateISO, count || 1);
      return Response.json({ ok: true });
    }
    if (action === 'incUsers') {
      const { createdDateISO } = body;
      if (!createdDateISO) return Response.json({ error: 'createdDateISO obrigatório' }, { status: 400 });
      if (user.role !== 'admin') {
        const records = await svc.entities.User.filter({ id: user.id });
        const dbUser = records?.[0];
        if (!dbUser) return Response.json({ error: 'Usuário não encontrado.' }, { status: 401 });
        const requestedDay = new Date(createdDateISO).toISOString().slice(0, 10);
        const userDay = new Date(dbUser.created_date).toISOString().slice(0, 10);
        if (requestedDay !== userDay) return Response.json({ error: 'Sem permissão para manter este contador.' }, { status: 403 });
        // P1 — idempotency: created_day is set by this handler on first count; replays no-op.
        if (dbUser.created_day) return Response.json({ ok: true, reason: "already_counted" });
      }
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
      // Normal users may only maintain the counter for their own Person, created recently.
      // Global/admin imports remain restricted to admins.
      if (user.role !== 'admin') {
        const persons = await svc.entities.Person.filter({ contact_email: user.email, is_active: true });
        const ownPerson = persons[0];
        if (!ownPerson) return Response.json({ error: 'Sem permissão para manter este contador.' }, { status: 403 });
        const requestedDay = new Date(createdDateISO).toISOString().slice(0, 10);
        const personDay = new Date(ownPerson.created_date).toISOString().slice(0, 10);
        if (requestedDay !== personDay) return Response.json({ error: 'Sem permissão para manter este contador.' }, { status: 403 });
        // P1 — idempotency: metrics_inc marks this Person already counted; replays no-op.
        if (ownPerson.metrics_inc) return Response.json({ ok: true, reason: "already_counted" });
        await incPersons(svc, createdDateISO);
        try { await svc.entities.Person.update(ownPerson.id, { metrics_inc: true }); } catch {}
        return Response.json({ ok: true });
      }
      await incPersons(svc, createdDateISO);
      return Response.json({ ok: true });
    }
    if (action === 'incPartners') {
      const { createdDateISO } = body;
      if (!createdDateISO) return Response.json({ error: 'createdDateISO obrigatório' }, { status: 400 });
      if (user.role !== 'admin') return Response.json({ error: 'Apenas administradores podem manter o contador global de parceiros.' }, { status: 403 });
      await incPartners(svc, createdDateISO);
      return Response.json({ ok: true });
    }
    if (action === 'decPartners') {
      const { createdDateISO } = body;
      if (!createdDateISO) return Response.json({ error: 'createdDateISO obrigatório' }, { status: 400 });
      if (user.role !== 'admin') return Response.json({ error: 'Apenas administradores podem manter o contador global de parceiros.' }, { status: 403 });
      await decPartners(svc, createdDateISO);
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'action inválido' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});