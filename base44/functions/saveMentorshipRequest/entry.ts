import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveUserPersonId } from "../../shared/eventAuth.ts";

async function participantBelongsToUser(base44, participantId, user, userPersonId) {
  if (!participantId) return false;
  if (user.role === 'admin') return true;
  const ps = await base44.asServiceRole.entities.Participant.filter({ id: participantId, is_deleted: false });
  const p = ps?.[0];
  if (!p) return false;
  if (userPersonId && p.person_id === userPersonId) return true;
  if (p.email && p.email.toLowerCase() === user.email.toLowerCase()) return true;
  return false;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json();
    const { id, status, eventId, sessionId, participantId, personId, mentorParticipantId, topic } = body;
    const userPersonId = await resolveUserPersonId(base44, user);

    if (id) {
      // UPDATE status (mentor marca atendida OU participante cancela)
      const reqs = await base44.asServiceRole.entities.MentorshipRequest.filter({ id });
      const m = reqs?.[0];
      if (!m) return Response.json({ error: 'Solicitação não encontrada.' }, { status: 404 });
      const isMentor = await participantBelongsToUser(base44, m.mentor_participant_id, user, userPersonId);
      const isRequester = await participantBelongsToUser(base44, m.participant_id, user, userPersonId);
      if (!isMentor && !isRequester) return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      await base44.asServiceRole.entities.MentorshipRequest.update(id, { status });
      return Response.json({ ok: true, id });
    }

    // CREATE (participante solicita mentoria)
    if (!eventId || !sessionId || !participantId) {
      return Response.json({ error: 'Parâmetros obrigatórios ausentes.' }, { status: 400 });
    }
    const ok = await participantBelongsToUser(base44, participantId, user, userPersonId);
    if (!ok) return Response.json({ error: 'Sem permissão para solicitar mentoria.' }, { status: 403 });

    const created = await base44.asServiceRole.entities.MentorshipRequest.create({
      event_id: eventId,
      session_id: sessionId,
      participant_id: participantId,
      person_id: personId,
      mentor_participant_id: mentorParticipantId,
      topic,
      status: 'requested',
      requested_at: new Date().toISOString(),
    });
    return Response.json({ ok: true, id: created.id });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});