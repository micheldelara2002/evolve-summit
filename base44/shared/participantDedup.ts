// P0 — Política de deduplicidade de participante (bloqueio com reativação):
// 1 e-mail ATIVO = 1 inscrição por evento. Nova inscrição/compra com e-mail que
// já possui inscrição ativa no mesmo evento é bloqueada; inscrição anterior
// cancelada/reembolsada permite a nova (a Person existente é reativada no
// fulfillment, em commerceFulfillment.ensurePerson).
//
// Usado por createPaymentIntent (checkout), manageParticipant (criação manual,
// edição e importação CSV) e dedupeEventParticipants (reconciliação de
// duplicatas legadas). Validado SEMPRE no servidor — nunca só no frontend.

export function normalizeParticipantEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Retorna o conjunto (Set) de e-mails que JÁ possui inscrição ativa no evento
 * ("ativa" = is_deleted false E registration_status != 'cancelled').
 * Consulta em fatias de 20 e-mails (janela segura para $in).
 * excludeParticipantId: ignora o próprio registro (usado na edição de e-mail).
 */
export async function findActiveDuplicateEmails(svc, eventId, emails, excludeParticipantId) {
  const keys = [];
  const seenMap = {};
  for (const raw of (emails || [])) {
    const key = normalizeParticipantEmail(raw);
    if (key && !seenMap[key]) {
      seenMap[key] = true;
      keys.push(key);
    }
  }

  const duplicates = {};
  const CHUNK_SIZE = 20;
  let idx = 0;
  while (keys.length > idx) {
    const chunk = keys.slice(idx, idx + CHUNK_SIZE);
    const filter = {
      event_id: eventId,
      email: { $in: chunk },
      is_deleted: false,
      registration_status: { $ne: 'cancelled' },
    };
    if (excludeParticipantId) filter.id = { $ne: excludeParticipantId };
    const found = await svc.entities.Participant.filter(filter);
    for (const p of found) {
      duplicates[normalizeParticipantEmail(p.email)] = true;
    }
    idx += CHUNK_SIZE;
  }
  return new Set(Object.keys(duplicates));
}