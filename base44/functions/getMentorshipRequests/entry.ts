import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveUserPersonId } from "../../shared/eventAuth.ts";
import { participantBelongsToUser } from "../../shared/participantOwnership.ts";

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { mentorParticipantIds, mentorParticipantId, participantId, sessionId } = await req.json();
    const userPersonId = await resolveUserPersonId(base44, user);

    const filter = {};
    if (sessionId) filter.session_id = sessionId;

    if (participantId) {
      const ok = await participantBelongsToUser(base44, participantId, user, userPersonId);
      if (!ok) return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      filter.participant_id = participantId;
    } else if (mentorParticipantId) {
      const ok = await participantBelongsToUser(base44, mentorParticipantId, user, userPersonId);
      if (!ok) return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      filter.mentor_participant_id = mentorParticipantId;
    } else if (Array.isArray(mentorParticipantIds) && mentorParticipantIds.length) {
      for (const pid of mentorParticipantIds) {
        const ok = await participantBelongsToUser(base44, pid, user, userPersonId);
        if (!ok) return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      }
      filter.mentor_participant_id = { $in: mentorParticipantIds };
    } else {
      return Response.json({ error: 'Informe participantId, mentorParticipantId ou mentorParticipantIds.' }, { status: 400 });
    }

    const mentorshipRequests = await base44.asServiceRole.entities.MentorshipRequest.filter(filter);
    return Response.json({ mentorshipRequests });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}