import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { canAccessEventData } from "../../shared/eventAuth.ts";

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json();
    const { id, eventId, ...payload } = body;
    if (!eventId) return Response.json({ error: 'eventId é obrigatório.' }, { status: 400 });

    // Revalidate event membership before any write — the executeRaffle draw already
    // validated, but the save itself did not revalidate. Now it does.
    const ok = await canAccessEventData(base44, user, eventId);
    if (!ok) return Response.json({ error: 'Sem permissão para salvar sorteios neste evento.' }, { status: 403 });

    if (id) {
      // Update path: revalidate that the existing raffle belongs to this event.
      const existing = await base44.asServiceRole.entities.Raffle.filter({ id, is_deleted: false });
      if (!existing?.length) return Response.json({ error: 'Sorteio não encontrado.' }, { status: 404 });
      if (existing[0].event_id !== eventId) {
        return Response.json({ error: 'Sorteio não pertence a este evento.' }, { status: 403 });
      }
      await base44.asServiceRole.entities.Raffle.update(id, { ...payload, event_id: eventId });
      return Response.json({ ok: true, id });
    }

    const created = await base44.asServiceRole.entities.Raffle.create({ ...payload, event_id: eventId });
    return Response.json({ ok: true, id: created.id });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}