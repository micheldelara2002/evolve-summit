// Session-scoped authorization for the Session Interaction domain (polls + Q&A).
//
// Resolves the caller's relationship to a Session using service role:
//   - isAdmin            (global admin)
//   - isSpeaker          (caller's Participant.id === Session.speaker_id)
//   - isAuthorizedParticipant (active Participant in the session's event)
//
// Client-provided IDs are NEVER trusted as proof of ownership. P1-A
// (2026-11-04): identity comes from shared/identity.ts (single precedence:
// verified user.person_id link > normalized contact_email > none; ambiguity is
// denial). The caller's Participant is resolved with targeted queries
// (person_ids + normalized e-mail), never by scanning the event roster.
//
// Import pattern (from a function entry.ts):
//   import { resolveSessionCaller, resolveCallerPerson } from "../../shared/sessionAuth.ts";

import { resolveIdentity, findMyParticipants } from "./identity.ts";

/** person_id canônico do chamador (requer identidade única; null se ambígua/ausente). */
export async function resolveCallerPerson(svc: any, user: any): Promise<string | null> {
  const identity = await resolveIdentity(svc, user);
  return identity.selfPersonId || null;
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

  const identity = await resolveIdentity(svc, user);

  // Caller's Participant record in the session's event — consultas direcionadas
  // por person_ids e e-mails normalizados (nunca varredura do evento).
  const candidates = await findMyParticipants(svc, identity, session.event_id);
  // Ambiguidade (mais de um registro) não escolhe um "primeiro": o chamador
  // fica sem Participant e a autorização de escrita é negada adiante.
  const participant = candidates.length === 1 ? candidates[0] : null;

  const isSpeaker = !!(participant && session.speaker_id && participant.id === session.speaker_id);
  const isAuthorizedParticipant = !!participant;

  return {
    isAdmin,
    session,
    personId: identity.selfPersonId,
    identity,
    participant,
    isSpeaker,
    isAuthorizedParticipant,
  };
}