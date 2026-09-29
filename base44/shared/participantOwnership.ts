// P2 (2026-09-29) — Fonte única da verificação de posse de um Participant.
// Era copiado idêntico em getMentorshipRequests e saveMentorshipRequest.
//
// Posse = admin OU o próprio registro: por person_id vinculado OU por e-mail
// do usuário autenticado. Lookup via service role (RLS de Participant é
// admin-only / dono-por-e-mail).

export async function participantBelongsToUser(base44: any, participantId: string, user: any, userPersonId: string | null): Promise<boolean> {
  if (!participantId) return false;
  if (user.role === 'admin') return true;
  const ps = await base44.asServiceRole.entities.Participant.filter({ id: participantId, is_deleted: false });
  const p = ps?.[0];
  if (!p) return false;
  if (userPersonId && p.person_id === userPersonId) return true;
  if (p.email && p.email.toLowerCase() === user.email.toLowerCase()) return true;
  return false;
}