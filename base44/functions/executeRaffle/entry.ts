import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { eventId, winnerCount, excludeIds = [] } = await req.json();

    if (!eventId) {
      return Response.json({ error: 'eventId é obrigatório.' }, { status: 400 });
    }

    // P0.2: Event-scoped authorization — verify manager has access to THIS event
    const raffleAuth = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
    if (!raffleAuth.authorized) {
      return Response.json({ error: 'Sem permissão para realizar sorteios neste evento.' }, { status: 403 });
    }

    // Fetch eligible participants from the DB — server-side, not trusting client pool
    const participants = await base44.asServiceRole.entities.Participant.filter({
      event_id: eventId,
      is_deleted: false,
      registration_status: { $ne: 'cancelled' },
    });

    if (!participants || participants.length === 0) {
      return Response.json({ error: 'Sem elegíveis disponíveis.' }, { status: 400 });
    }

    const pool = participants
      .map((p) => ({ id: p.id, full_name: p.full_name, email: p.email, company: p.company }))
      .filter((p) => p.id && !excludeIds.includes(p.id));

    if (pool.length === 0) {
      return Response.json({ error: 'Sem elegíveis disponíveis após exclusões.' }, { status: 400 });
    }

    const count = Math.max(1, parseInt(winnerCount) || 1);

    // Fisher-Yates shuffle com aleatoriedade criptograficamente segura
    const arr = [...pool];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = secureRandomInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }

    const winners = arr.slice(0, Math.min(count, arr.length)).map((p) => ({
      id: p.id,
      full_name: p.full_name,
      email: p.email,
      company: p.company,
      confirmed: false,
    }));

    return Response.json({ winners, drawnAt: new Date().toISOString() });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});

/**
 * Gera inteiro aleatório [0, max) sem viés de módulo, usando Web Crypto API.
 */
function secureRandomInt(max) {
  const maxUint32 = 0xFFFFFFFF;
  const limit = maxUint32 - (maxUint32 % max);
  const buf = new Uint32Array(1);
  let val;
  do {
    crypto.getRandomValues(buf);
    val = buf[0];
  } while (val > limit);
  return val % max;
}