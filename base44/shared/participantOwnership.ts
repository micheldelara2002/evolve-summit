// P2 (2026-09-29) — Fonte única da verificação de posse de um Participant.
// Era copiado idêntico em getMentorshipRequests e saveMentorshipRequest.
//
// P1-A (2026-11-04) — a posse é decidida pelo conjunto VERIFICADO de identidade
// (shared/identity.ts): person_ids do usuário (vínculo explícito + correspondências
// de e-mail normalizadas) ou e-mail normalizado do próprio Participant. Nunca por
// um único person_id escolhido entre candidatos ambíguos.
//
// Lookup via service role (RLS de Participant é admin-only / dono-por-e-mail).

import { resolveIdentity, identityOwnsParticipant } from "./identity.ts";

export async function participantBelongsToUser(base44: any, participantId: string, user: any): Promise<boolean> {
  if (!participantId || !user) return false;
  if (user.role === 'admin') return true;
  const ps = await base44.asServiceRole.entities.Participant.filter({ id: participantId, is_deleted: false });
  const p = ps?.[0];
  if (!p) return false;
  const identity = await resolveIdentity(base44, user);
  return identityOwnsParticipant(identity, p);
}