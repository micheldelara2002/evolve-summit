// Session-scoped authorization for the Session Interaction domain (polls + Q&A).
//
// Resolves the caller's relationship to a Session using service role:
//   - isAdmin            (global admin)
//   - isSpeaker          (caller's Participant.id === Session.speaker_id)
//   - isAuthorizedParticipant (active Participant in the session's event)
//
// Client-provided IDs are NEVER trusted as proof of ownership. The caller's
// person_id is resolved from auth.me() (user.person_id or Person.contact_email
// match), and the speaker ownership is verified against Session.speaker_id.
//
// Import pattern (from a function entry.ts):
//   import { resolveSessionCaller, resolveCallerPerson } from "../../shared/sessionAuth.ts";

export async function resolveCallerPerson(svc: any, user: any): Promise<string | null> {
  let personId: string | null = user?.person_id || null;
  if (!personId && user?.email) {
    const persons = await svc.entities.Person.filter({ contact_email: user.email });
    personId = persons?.[0]?.id || null;
  }
  return personId;
}

/**
 * Resolves the caller's relationship to a single Session.
 * @returns object with authorization flags + the session/participant records, or null if session not found.
 */
export async function resolveSessionCaller(svc: any, user: any, sessionId: string) {
  if (!user || !sessionId) return null;
  const isAdmin = user.role === 'admin';

  const sessions = await svc.entities.Session.filter({ id: sessionId, is_deleted: false });
  const session = sessions?.[0];
  if (!session) return null;

  const personId = await resolveCallerPerson(svc, user);

  // Find the caller's Participant record in the session's event.
  let participant: any = null;
  if (personId || user.email) {
    const parts = await svc.entities.Participant.filter({ event_id: session.event_id, is_deleted: false });
    participant =
      parts.find(
        (p: any) =>
          p.registration_status !== 'cancelled' &&
          ((personId && p.person_id === personId) || (user.email && p.email === user.email))
      ) || null;
  }

  const isSpeaker = !!(participant && session.speaker_id && participant.id === session.speaker_id);
  const isAuthorizedParticipant = !!participant;

  return { isAdmin, session, personId, participant, isSpeaker, isAuthorizedParticipant };
}