import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveUserPersonId } from "../../shared/eventAuth.ts";

// Lote 3 — Verifica se o participante autenticado já visitou um parceiro
// (lead source=booth_scan) num evento. Usado pelo PartnerVisitModal para
// bloquear visita duplicada. Valida que personId pertence ao usuário.
//
// Payload: { eventId, partnerId, personId }

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { eventId, partnerId, personId } = body;
    if (!eventId || !partnerId || !personId) {
      return Response.json({ error: 'eventId, partnerId e personId são obrigatórios.' }, { status: 400 });
    }

    // Valida que personId pertence ao usuário autenticado.
    const userPersonId = user.person_id || await resolveUserPersonId(base44, user);
    if (userPersonId !== personId && user.role !== 'admin') {
      return Response.json({ error: 'Sem permissão.' }, { status: 403 });
    }

    const svc = base44.asServiceRole;
    const existing = await svc.entities.Lead.filter({
      event_id: eventId,
      partner_id: partnerId,
      person_id: personId,
      source: "booth_scan",
    });

    return Response.json({ alreadyVisited: existing.length > 0 });
  } catch (error: any) {
    console.error('[checkExistingVisit]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}