// P1 — Badge de não-lidas do chat, derivado do próprio ChatThread
// (last_message_at + marcadores de leitura por lado). Substitui a antiga
// "notificação" de nova mensagem, que criava uma NotificationCampaign/Recipient
// por mensagem enviada.
export function threadUnreadFor(thread, myPersonId) {
  if (!thread?.last_message_at || !myPersonId) return false;
  const marker = thread.person_a_id === myPersonId ? thread.last_read_at_a : thread.last_read_at_b;
  return new Date(thread.last_message_at).getTime() > (marker ? new Date(marker).getTime() : 0);
}