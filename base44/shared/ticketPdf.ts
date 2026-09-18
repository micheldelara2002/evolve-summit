// Gera o PDF de um ingresso (backend/Deno) usando jsPDF + QR code (PNG via serviço).
// Usado no fulfillment para enviar por email (link) e armazenar pdf_url no Ticket.
//
// O PDF contém: nome do evento, data/local, titular, tipo/lote, valor pago,
// código do ingresso, QR code (do hash_code) e link do app.
//
// Importado DIRETAMENTE pelos entry.ts (webhook/getPaymentStatus) — NÃO via outro
// shared module, pois npm:jspdf não empacota em importação transitiva.

import { jsPDF } from 'npm:jspdf@4.2.1';

export type TicketPdfInput = {
  eventName: string;
  eventDate?: string;
  eventLocation?: string;
  holderName: string;
  ticketTypeName: string;
  lotName?: string;
  pricePaid: number;
  hashCode: string;
  appUrl: string;
  // Recibo (opcional) — dados do pagamento + recebedor. A NF fica a cargo do
  // emissor de nota do organizador (CNPJ dele).
  paidAt?: string;
  paymentMethod?: string;
  receiverName?: string;
  receiverDoc?: string;
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  card: 'Cartão',
  credit_card: 'Cartão de crédito',
  pix: 'Pix',
  boleto: 'Boleto',
  free: 'Gratuito',
};

export async function generateTicketPdfBytes(opts: TicketPdfInput): Promise<Uint8Array> {
  const hasReceipt = !!(opts.paidAt || opts.paymentMethod || opts.receiverName || opts.receiverDoc);
  const doc = new jsPDF({ unit: 'pt', format: [380, hasReceipt ? 750 : 600] });

  // Header band
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, 380, 90, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text((opts.eventName || 'Evento').slice(0, 42), 30, 38, { maxWidth: 320 });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text('INGRESSO', 30, 58);

  doc.setTextColor(15, 23, 42);
  let y = 120;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Titular', 30, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  doc.text(String(opts.holderName || '—').slice(0, 46), 30, y + 16);

  y += 46;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Tipo', 30, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  doc.text(`${opts.ticketTypeName || 'Ingresso'}${opts.lotName ? ' — ' + opts.lotName : ''}`.slice(0, 46), 30, y + 16);

  y += 46;
  if (opts.eventDate) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Data', 30, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(12);
    try {
      doc.text(new Date(opts.eventDate).toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' }), 30, y + 16, { maxWidth: 320 });
    } catch {
      doc.text(String(opts.eventDate), 30, y + 16);
    }
    y += 40;
  }
  if (opts.eventLocation) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Local', 30, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(12);
    doc.text(String(opts.eventLocation).slice(0, 120), 30, y + 16, { maxWidth: 320 });
    y += 40;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Valor pago', 30, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(14);
  doc.text(`R$ ${Number(opts.pricePaid || 0).toFixed(2)}`, 30, y + 16);

  try {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(opts.hashCode)}`;
    const qrRes = await fetch(qrUrl);
    if (qrRes.ok) {
      const qrBuf = new Uint8Array(await qrRes.arrayBuffer());
      doc.addImage(qrBuf, 'PNG', 130, 360, 120, 120);
    }
  } catch (err) {
    console.error('[ticketPdf] QR fetch failed:', err?.message || err);
  }

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(`Código: ${opts.hashCode}`, 190, 500, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(`Acesse o app: ${opts.appUrl}`, 190, 560, { align: 'center', maxWidth: 340 });

  // Seção RECIBO — valor, data, forma de pagamento e recebedor (organizador).
  if (hasReceipt) {
    let ry = 615;
    doc.setDrawColor(226, 232, 240);
    doc.line(30, 595, 350, 595);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text('RECIBO', 30, ry);
    doc.setTextColor(15, 23, 42);
    ry += 16;
    doc.setFont('helvetica', 'normal');
    if (opts.paidAt) {
      try {
        doc.text(`Data do pagamento: ${new Date(opts.paidAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`, 30, ry, { maxWidth: 320 });
      } catch {
        doc.text(`Data do pagamento: ${String(opts.paidAt)}`, 30, ry, { maxWidth: 320 });
      }
      ry += 13;
    }
    if (opts.paymentMethod) {
      doc.text(`Forma de pagamento: ${PAYMENT_METHOD_LABELS[opts.paymentMethod] || opts.paymentMethod}`, 30, ry, { maxWidth: 320 });
      ry += 13;
    }
    if (opts.receiverName) {
      doc.text(`Recebedor: ${String(opts.receiverName).slice(0, 60)}`, 30, ry, { maxWidth: 320 });
      ry += 13;
    }
    if (opts.receiverDoc) {
      doc.text(`CNPJ: ${String(opts.receiverDoc)}`, 30, ry, { maxWidth: 320 });
    }
  }

  return doc.output('arraybuffer') as Uint8Array;
}

const APP_URL = 'https://evolve-summit.base44.app';

// Entrega os ingressos: gera PDF (com QR), faz upload, armazena pdf_url no Ticket
// e envia por email ao titular. Idempotente — pula ingressos que já têm pdf_url.
export async function deliverTickets(svc: any, event: any, order: any, tickets: any[], orderItems: any[]): Promise<void> {
  // Dados do recibo: pagamento (data/método) + recebedor (conta conectada
  // do organizador vinculada ao evento).
  let receipt: any = {};
  try {
    const payment = (await svc.entities.Payment.filter({ order_id: order.id }))[0] || null;
    const payoutAccount = event?.payout_account_id
      ? ((await svc.entities.PayoutAccount.filter({ id: event.payout_account_id }))[0] || null)
      : null;
    receipt = {
      paidAt: payment?.succeeded_at || order?.created_date || '',
      paymentMethod: payment?.payment_method || '',
      receiverName: payoutAccount?.legal_name || '',
      receiverDoc: payoutAccount?.legal_document_number || '',
    };
  } catch (err: any) {
    console.error('[deliverTickets] receipt data failed:', err?.message || err);
  }
  const itemByOrderItem = new Map<string, any>();
  for (const it of orderItems) itemByOrderItem.set(it.id, it);
  for (const ticket of tickets) {
    if (ticket.pdf_url) continue;
    const item = itemByOrderItem.get(ticket.order_item_id);
    if (!item) continue;
    try {
      const pdfBytes = await generateTicketPdfBytes({
        eventName: event?.name || 'Evento',
        eventDate: event?.start_date,
        eventLocation: event?.location,
        holderName: item.holder_name,
        ticketTypeName: item.ticket_type_name,
        lotName: '',
        pricePaid: item.unit_price,
        hashCode: ticket.hash_code,
        appUrl: APP_URL,
        paidAt: receipt.paidAt,
        paymentMethod: receipt.paymentMethod,
        receiverName: receipt.receiverName,
        receiverDoc: receipt.receiverDoc,
      });
      let fileUrl = '';
      try {
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const up: any = await svc.integrations.Core.UploadFile({ file: blob });
        fileUrl = up?.file_url || '';
        if (fileUrl) await svc.entities.Ticket.update(ticket.id, { pdf_url: fileUrl });
      } catch (upErr: any) {
        console.error('[deliverTickets] upload failed:', upErr?.message || upErr);
      }
      if (item.holder_email) {
        const body =
          `Olá ${item.holder_name},\n\nSeu ingresso para "${event?.name || 'Evento'}" foi confirmado!\n\n` +
          `Titular: ${item.holder_name}\nTipo: ${item.ticket_type_name}\nValor: R$ ${Number(item.unit_price).toFixed(2)}\n` +
          `Código: ${ticket.hash_code}\n\n` +
          (fileUrl ? `Baixe seu ingresso (com QR code para o check-in):\n${fileUrl}\n\n` : '') +
          `Acesse o app: ${APP_URL}\n\nEvolve Summit`;
        await svc.integrations.Core.SendEmail({
          to: item.holder_email,
          subject: `Ingresso — ${event?.name || 'Evento'}`,
          body,
        });
      }
    } catch (err: any) {
      console.error('[deliverTickets] failed for ticket', ticket.id, err?.message || err);
    }
  }
}