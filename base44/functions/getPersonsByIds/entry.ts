// getPersonsByIds — Lote 4. Leitura de Persons por IDs, autorizada por evento.
// Admin: retorna qualquer Person solicitada. Não-admin: deve indicar eventIds
// aos quais tem acesso (canAccessEventData) e só recebe Persons que são
// participantes (Person vinculado via Participant.person_id) nesses eventos.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { canAccessEventData } from '../../shared/eventAuth.ts';
import { validIds } from '../../shared/idGuard.ts';

const MAX_PERSONS = 200;
const MAX_EVENTS = 10;

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Não autenticado.' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const personIds = validIds(body.personIds).slice(0, MAX_PERSONS);
    const svc = base44.asServiceRole;

    if (user.role === 'admin') {
      if (!personIds.length) return Response.json({ persons: [] });
      const persons = await svc.entities.Person.filter({ id: { $in: personIds } });
      return Response.json({ persons });
    }

    // Não-admin: exige eventos com acesso;Persons elegíveis = participantes do evento
    const eventIds = validIds(body.eventIds).slice(0, MAX_EVENTS);
    if (!eventIds.length) {
      return Response.json({ error: 'eventIds é obrigatório para esta consulta.' }, { status: 403 });
    }
    if (!personIds.length) return Response.json({ persons: [] });

    const eligible = new Set();
    for (const eventId of eventIds) {
      const ok = await canAccessEventData(base44, user, eventId);
      if (!ok) continue;
      const participants = await svc.entities.Participant.filter({
        event_id: eventId,
        person_id: { $in: personIds },
        is_deleted: false,
      });
      for (const p of participants) if (p.person_id) eligible.add(p.person_id);
    }
    if (!eligible.size) return Response.json({ persons: [] });

    const persons = await svc.entities.Person.filter({ id: { $in: [...eligible] } });
    return Response.json({ persons });
  } catch (error) {
    console.error('getPersonsByIds error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}