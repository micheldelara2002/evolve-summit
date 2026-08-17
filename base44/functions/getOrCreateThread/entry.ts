import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";

function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim();
}

function sortPersonIds(a, b) {
  return a < b ? [a, b] : [b, a];
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { eventId, myPersonId, myPersonName, otherPersonId, otherPersonName } = await req.json();
    if (!eventId || !myPersonId || !otherPersonId) {
      return Response.json({ error: 'Parâmetros obrigatórios ausentes.' }, { status: 400 });
    }

    // Verify ownership: myPersonId must belong to calling user
    const userPersons = await base44.asServiceRole.entities.Person.filter({ contact_email: user.email });
    const userPersonId = userPersons[0]?.id;
    if (myPersonId !== userPersonId && user.role !== 'admin') {
      return Response.json({ error: 'Sem permissão.' }, { status: 403 });
    }

    const [aId, bId] = sortPersonIds(myPersonId, otherPersonId);
    const safeMyName = sanitizeText(myPersonName);
    const safeOtherName = sanitizeText(otherPersonName);

    // 1. Thread já existe?
    const existing = await base44.asServiceRole.entities.ChatThread.filter({
      event_id: eventId, person_a_id: aId, person_b_id: bId, is_deleted: false,
    });
    if (existing?.length > 0) return Response.json(existing[0]);

    // 2. Criar nova thread
    const thread = await base44.asServiceRole.entities.ChatThread.create({
      event_id: eventId,
      person_a_id: aId,
      person_b_id: bId,
      person_a_name: aId === myPersonId ? safeMyName : safeOtherName,
      person_b_name: bId === myPersonId ? safeMyName : safeOtherName,
    });

    // 3. Race protection — se request concorrente criou duplicata, manter a mais antiga
    const threads = await base44.asServiceRole.entities.ChatThread.filter({
      event_id: eventId, person_a_id: aId, person_b_id: bId, is_deleted: false,
    });
    if (threads.length > 1) {
      threads.sort((a, b) => new Date(a.created_date) - new Date(b.created_date));
      const duplicates = threads.slice(1);
      for (const d of duplicates) {
        await base44.asServiceRole.entities.ChatThread.update(d.id, { is_deleted: true });
      }
      return Response.json(threads[0]);
    }

    return Response.json(thread);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});