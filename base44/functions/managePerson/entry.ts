// managePerson — Lote 4. Porta de gestão de Persons para admins e gestores de evento.
//   op='search' { query, eventId? } → Persons (admin: global; gestor: participantes do evento)
//   op='save'   { eventId?, personId?, data } → create/update autorizado
// Admin pode tudo. Gestor (EventMembership manager/team) opera Persons vinculadas
// a participantes do evento (ou cria novas). RLS Person é admin-only — via service role.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { verifyEventMembership, EVENT_MANAGER_ROLES } from '../../shared/eventAuth.ts';
import { validIds, isValidId } from '../../shared/idGuard.ts';
import { incPersons } from '../../shared/businessMetrics.ts';

const ALLOWED_FIELDS = [
  'full_name', 'contact_email', 'phone', 'company', 'job_title',
  'photo_url', 'bio', 'linkedin', 'instagram', 'youtube', 'website', 'is_active',
];
const MAX_LEN = 2000;
const MAX_PERSONS = 500;

function sanitizeData(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const key of ALLOWED_FIELDS) {
    if (key in data && data[key] !== undefined && data[key] !== null) {
      if (key === 'is_active') {
        out[key] = data[key] === true;
      } else {
        out[key] = String(data[key]).trim().slice(0, MAX_LEN);
      }
    }
  }
  return out;
}

function matchesQuery(person, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    (person.full_name || '').toLowerCase().includes(q) ||
    (person.contact_email || '').toLowerCase().includes(q)
  );
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Não autenticado.' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const op = String(body.op || '');
    const svc = base44.asServiceRole;

    if (op === 'search') {
      const query = String(body.query || '').trim().slice(0, 120);
      const eventId = isValidId(body.eventId) ? body.eventId : null;

      if (user.role === 'admin' && !eventId) {
        const all = await svc.entities.Person.list('-full_name', MAX_PERSONS);
        return Response.json({ persons: all.filter((p) => matchesQuery(p, query)) });
      }

      const targetEventId = eventId;
      if (!targetEventId) {
        return Response.json({ error: 'eventId é obrigatório para esta consulta.' }, { status: 403 });
      }
      const { authorized } = await verifyEventMembership(base44, user, targetEventId, EVENT_MANAGER_ROLES);
      if (!authorized) {
        return Response.json({ error: 'Sem permissão para buscar pessoas deste evento.' }, { status: 403 });
      }
      const participants = await svc.entities.Participant.filter({
        event_id: targetEventId,
        is_deleted: false,
      });
      const personIds = [...new Set(participants.map((p) => p.person_id).filter(Boolean))];
      if (!personIds.length) return Response.json({ persons: [] });
      const persons = await svc.entities.Person.filter({ id: { $in: personIds.slice(0, MAX_PERSONS) } });
      return Response.json({ persons: persons.filter((p) => matchesQuery(p, query)) });
    }

    if (op === 'save') {
      const eventId = isValidId(body.eventId) ? body.eventId : null;
      const personId = isValidId(body.personId) ? body.personId : null;
      const data = sanitizeData(body.data);

      const isAdmin = user.role === 'admin';
      if (!isAdmin) {
        if (!eventId) {
          return Response.json({ error: 'eventId é obrigatório.' }, { status: 403 });
        }
        const { authorized } = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
        if (!authorized) {
          return Response.json({ error: 'Sem permissão para gerenciar pessoas deste evento.' }, { status: 403 });
        }
        if (personId) {
          // Gestor só edita Persons de participantes do próprio evento
          const participants = await svc.entities.Participant.filter({
            event_id: eventId,
            person_id: personId,
            is_deleted: false,
          });
          if (!participants.length) {
            return Response.json({ error: 'Pessoa não encontrada neste evento.' }, { status: 404 });
          }
        }
      }

      if (personId) {
        const found = await svc.entities.Person.filter({ id: personId });
        if (!found.length) return Response.json({ error: 'Pessoa não encontrada.' }, { status: 404 });
        const updated = await svc.entities.Person.update(personId, data);
        return Response.json({ person: updated });
      }

      if (!data.full_name) return Response.json({ error: 'Nome é obrigatório.' }, { status: 400 });
      const created = await svc.entities.Person.create({
        ...data,
        created_day: new Date().toISOString().slice(0, 10),
      });
      // P1 — contador global idempotente (reconcile corrige drift)
      try {
        if (created && created.metrics_inc !== true) {
          await incPersons(svc, created.created_date || new Date().toISOString());
          await svc.entities.Person.update(created.id, { metrics_inc: true });
        }
      } catch (e) { /* best-effort */ }
      return Response.json({ person: created });
    }

    return Response.json({ error: 'Operação desconhecida: ' + op }, { status: 400 });
  } catch (error) {
    console.error('managePerson error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}