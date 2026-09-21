import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { generateTicketPdfBytes, buildTicketPdfExtras } from "../../shared/ticketPdf.ts";

// Download do PDF do ingresso (com QR + recibo financeiro) pelo titular ou
// comprador. Se o PDF ainda não foi gerado no fulfillment, gera sob demanda,
// armazena pdf_url no Ticket e devolve o link (idempotente — o mesmo gerador
// usado no fulfillment, sem duplicar lógica).
//
// Payload: { ticketId }

const APP_URL = 'https://app.evolveinst.com';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;

    const body = await req.json().catch(() => ({}));
    const { ticketId } = body;
    if (!ticketId) return Response.json({ error: "ticketId obrigatório." }, { status: 400 });

    const ticket = (await svc.entities.Ticket.filter({ id: ticketId, is_deleted: false }))[0];
    if (!ticket) return Response.json({ error: "Ingresso não encontrado." }, { status: 404 });

    const order = ticket.order_id
      ? ((await svc.entities.Order.filter({ id: ticket.order_id }))[0] || null)
      : null;

    const isHolder = !!ticket.holder_email &&
      ticket.holder_email.toLowerCase() === String(user.email || "").toLowerCase();
    const isBuyer = !!order && order.buyer_user_id === user.id;
    if (!isHolder && !isBuyer) {
      return Response.json({ error: "Sem permissão." }, { status: 403 });
    }

    if (ticket.pdf_url) return Response.json({ file_url: ticket.pdf_url });

    const event = (await svc.entities.Event.filter({ id: ticket.event_id }))[0];
    if (!event) return Response.json({ error: "Evento não encontrado." }, { status: 404 });

    const item = ticket.order_item_id
      ? ((await svc.entities.OrderItem.filter({ id: ticket.order_item_id }))[0] || null)
      : null;

    // Recibo — mesmos dados do fulfillment: pagamento + conta recebedora do evento.
    let receipt: any = {};
    try {
      const payment = ticket.order_id
        ? ((await svc.entities.Payment.filter({ order_id: ticket.order_id }))[0] || null)
        : null;
      const payoutAccount = event.payout_account_id
        ? ((await svc.entities.PayoutAccount.filter({ id: event.payout_account_id }))[0] || null)
        : null;
      receipt = {
        paidAt: payment?.succeeded_at || order?.created_date || '',
        paymentMethod: payment?.payment_method || '',
        receiverName: payoutAccount?.legal_name || '',
        receiverDoc: payoutAccount?.legal_document_number || '',
      };
    } catch (err: any) {
      console.error('[getTicketPdf] receipt data failed:', err?.message || err);
    }

    const extras = await buildTicketPdfExtras(svc, event);
    const pdfBytes = await generateTicketPdfBytes({
      eventName: event.name || 'Evento',
      eventDate: event.start_date,
      eventLocation: event.location,
      eventLogoUrl: extras.eventLogoUrl,
      sponsors: extras.sponsors,
      refundPolicyLines: extras.refundPolicyLines,
      holderName: ticket.holder_name,
      ticketTypeName: ticket.ticket_type_name || item?.ticket_type_name || 'Ingresso',
      lotName: '',
      pricePaid: item?.unit_price ?? 0,
      hashCode: ticket.hash_code,
      appUrl: APP_URL,
      paidAt: receipt.paidAt,
      paymentMethod: receipt.paymentMethod,
      receiverName: receipt.receiverName,
      receiverDoc: receipt.receiverDoc,
    });

    // Upload de arquivos gerados no backend não é suportado pela integração
    // (exige multipart) — devolvemos o PDF em base64 e o frontend monta o
    // download. pdf_url é usado apenas para ingressos legados que já têm link.
    let b64 = '';
    try {
      let s = '';
      for (let i = 0; i < pdfBytes.length; i += 0x8000) {
        s += String.fromCharCode(...pdfBytes.subarray(i, i + 0x8000));
      }
      b64 = btoa(s);
    } catch (err: any) {
      console.error('[getTicketPdf] base64 encode failed:', err?.message || err);
    }
    if (!b64) return Response.json({ error: "Falha ao gerar o PDF do ingresso." }, { status: 500 });

    return Response.json({
      file_base64: b64,
      filename: `ingresso-${ticket.hash_code}.pdf`,
    });
  } catch (error: any) {
    console.error('[getTicketPdf]', error?.message || error);
    return Response.json({ error: error?.message || "Erro interno." }, { status: 500 });
  }
}