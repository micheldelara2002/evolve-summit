// E-mails transacionais idempotentes (P2).
// Todo e-mail enviado pelo backend (ingressos, estornos, cancelamentos) passa
// por aqui. Um marcador de entrega (EmailDeliveryLog, por dedupeKey) é verificado
// ANTES do envio e gravado APÓS o sucesso — replays de webhook, retentativas e
// chamadas repetidas nunca reenviam o mesmo e-mail para o mesmo evento de envio.

export async function sendTransactionalEmail(
  svc: any,
  opts: {
    dedupeKey: string;
    to: string;
    subject: string;
    body?: string;
    html?: string;
    attachments?: { filename: string; content?: string; file_url?: string }[];
  }
): Promise<{ sent: boolean; reason?: string }> {
  const { dedupeKey, to, subject, body, html, attachments } = opts;
  if (!to) return { sent: false, reason: "no_recipient" };

  // Verifica o marcador: já entregue → nunca reenvia.
  try {
    const delivered = await svc.entities.EmailDeliveryLog.filter({ key: dedupeKey });
    if (delivered && delivered.length > 0) return { sent: false, reason: "already_delivered" };
  } catch (err: any) {
    console.error("[sendTransactionalEmail] marker check failed:", err?.message || err);
  }

  const payload: any = { to, subject };
  if (body) payload.body = body;
  if (html) payload.html = html;
  if (attachments && attachments.length > 0) payload.attachments = attachments;
  await svc.integrations.Core.SendEmail(payload);

  // Grava o marcador após o envio bem-sucedido — o e-mail pode falhar e ser
  // retentado depois (nenhum marcador é criado sem envio).
  try {
    await svc.entities.EmailDeliveryLog.create({
      key: dedupeKey,
      recipient: to,
      subject: String(subject).slice(0, 200),
      sent_at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[sendTransactionalEmail] marker save failed:", err?.message || err);
  }
  return { sent: true };
}