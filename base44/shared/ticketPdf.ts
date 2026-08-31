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
};

export async function generateTicketPdfBytes(opts: TicketPdfInput): Promise<Uint8Array> {
  const doc = new jsPDF({ unit: 'pt', format: [380, 600] });

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

  return doc.output('arraybuffer') as Uint8Array;
}

const APP_URL = 'https://evolve-summit.base44.app';

// Entrega os ingressos: gera PDF (com QR), faz upload, armazena pdf_url no Ticket
// e envia por email ao titular. Idempotente — pula ingressos que já têm pdf_url.
export async function deliverTickets(svc: any, event: any, order: any, tickets: any[], orderItems: any[]): Promise<void> {
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