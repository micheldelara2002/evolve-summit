import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { canAccessEventData } from "../../shared/eventAuth.ts";

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { eventId } = await req.json();
    if (!eventId) return Response.json({ error: 'eventId é obrigatório.' }, { status: 400 });

    const ok = await canAccessEventData(base44, user, eventId);
    if (!ok) return Response.json({ error: 'Sem permissão para acessar sorteios deste evento.' }, { status: 403 });

    const raffles = await base44.asServiceRole.entities.Raffle.filter({
      event_id: eventId,
      is_deleted: false,
    });
    return Response.json({ raffles });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}