import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { generateTicketPdfBytes, buildTicketPdfExtras, buildTicketReceipt, APP_URL } from "../../shared/ticketPdf.ts";

// Download do PDF do ingresso (com QR + recibo financeiro) pelo titular ou
// comprador. Se o PDF ainda não foi gerado no fulfillment, gera sob demanda,
// armazena pdf_url no Ticket e devolve o link (idempotente — o mesmo gerador
// usado no fulfillment, sem duplicar lógica).
//
// Payload: { ticketId }

// Rate limit por usuário (janela deslizante em memória do isolate —
// best-effort): a geração de PDF é custosa (QR + jsPDF + imagens). Teto de
// 10 gerações/minuto/usuário; excedentes recebem 429 sem consumir CPU.
const PDF_RATE_WINDOW_MS = 60_000;
const PDF_RATE_MAX = 10;
const pdfRateHits = new Map<string, number[]>();
// Poda do mapa (2026-10-17): o isolate vive mais que um request — sem poda, as
// chaves crescem sem limite (um abuso com N usuários infla a memória). Mantém
// as janelas ativas mais recentes; chaves podadas apenas perdem o histórico da
// janela (o limite volta a contar do zero — pior caso: +10 gerações/min).
const PDF_RATE_MAX_KEYS = 500;
function pdfRateLimited(key: string): boolean {
  if (pdfRateHits.size > PDF_RATE_MAX_KEYS) {
    for (const k of Array.from(pdfRateHits.keys()).slice(0, 100)) pdfRateHits.delete(k);
  }
  const now = Date.now();
  const hits = (pdfRateHits.get(key) || []).filter((t) => now - t < PDF_RATE_WINDOW_MS);
  if (hits.length >= PDF_RATE_MAX) {
    pdfRateHits.set(key, hits);
    return true;
  }
  hits.push(now);
  pdfRateHits.set(key, hits);
  return false;
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    if (pdfRateLimited('pdf:' + user.id)) {
      return Response.json({ error: 'Muitas solicitações. Tente novamente em instantes.' }, { status: 429 });
    }
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

    // AUD-009 — recibo montado pelo helper compartilhado (fonte única).
    const receipt = await buildTicketReceipt(svc, order, event);

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