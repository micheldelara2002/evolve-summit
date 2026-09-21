// Gera o PDF de um ingresso (backend/Deno) usando jsPDF + QR code (PNG via serviço).
// Usado no fulfillment (anexo por email) e no download sob demanda (getTicketPdf).
//
// O PDF contém: logo do evento, nome, data/local, titular, tipo/lote, valor pago,
// código do ingresso, QR code (do hash_code), link do app, política de devolução
// do evento e patrocinadores por nível (diamante/ouro/prata/bronze/apoiador).
//
// Importado DIRETAMENTE pelos entry.ts (webhook/getPaymentStatus/getTicketPdf) —
// NÃO via outro shared module, pois npm:jspdf não empacota em importação transitiva.
// (commercePolicy.ts é TS puro, sem deps npm — seguro importar daqui.)

import { jsPDF } from 'npm:jspdf@4.2.1';
import { DEFAULT_GLOBAL_REFUND_POLICY } from './commercePolicy.ts';

export type TicketSponsor = {
  name: string;
  logoUrl?: string;
  tier?: string;
};

export type TicketPdfInput = {
  eventName: string;
  eventDate?: string;
  eventLocation?: string;
  eventLogoUrl?: string;
  holderName: string;
  ticketTypeName: string;
  lotName?: string;
  pricePaid: number;
  hashCode: string;
  appUrl: string;
  sponsors?: TicketSponsor[];
  refundPolicyLines?: string[];
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

const TIER_ORDER = ['diamante', 'ouro', 'prata', 'bronze', 'apoiador'];
const TIER_LABELS: Record<string, string> = {
  diamante: 'DIAMANTE',
  ouro: 'OURO',
  prata: 'PRATA',
  bronze: 'BRONZE',
  apoiador: 'APOIADOR',
};

const W = 380;
const M = 30;
const CONTENT_W = W - M * 2; // 320

// Caixa de logo de patrocinador no rodapé
const SPONSOR_BOX_W = 96;
const SPONSOR_BOX_H = 34;
const SPONSOR_GAP = 16;

// Baixa uma imagem (PNG/JPEG) para embutir no PDF. Retorna null se indisponível.
async function fetchImage(url?: string): Promise<{ data: Uint8Array; format: string } | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 4) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('png') || (buf[0] === 0x89 && buf[1] === 0x50)) return { data: buf, format: 'PNG' };
    if (ct.includes('jpeg') || ct.includes('jpg') || buf[0] === 0xff) return { data: buf, format: 'JPEG' };
    return null;
  } catch {
    return null;
  }
}

function formatEventDate(d?: string): string {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' });
  } catch {
    return String(d);
  }
}

export async function generateTicketPdfBytes(opts: TicketPdfInput): Promise<Uint8Array> {
  const hasReceipt = !!(opts.paidAt || opts.paymentMethod || opts.receiverName || opts.receiverDoc);

  // Pré-busca de imagens (paralela): QR, logo do evento e logos dos patrocinadores.
  const sponsors = (opts.sponsors || []).slice(0, 12);
  const [qrImg, logoImg, ...sponsorImgs] = await Promise.all([
    fetchImage(`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(opts.hashCode)}`),
    fetchImage(opts.eventLogoUrl),
    ...sponsors.map((s) => fetchImage(s.logoUrl)),
  ]);
  const sponsorImgByIdx: (typeof qrImg)[] = sponsorImgs;

  // Agrupa patrocinadores por nível (ordem diamante → apoiador).
  const groups = TIER_ORDER
    .map((tier) => ({
      tier,
      items: sponsors.map((s, idx) => ({ ...s, img: sponsorImgByIdx[idx] })).filter((s) => (s.tier || '').toLowerCase() === tier),
    }))
    .filter((g) => g.items.length > 0);

  // Medição de texto (larguras de página fixas) para calcular a altura da página.
  const measure = new jsPDF({ unit: 'pt', format: [W, 2000] });
  const locLines: string[] = opts.eventLocation
    ? measure.splitTextToSize(String(opts.eventLocation).slice(0, 160), CONTENT_W)
    : [];
  const refundLines: string[] = (opts.refundPolicyLines || [])
    .flatMap((l) => measure.splitTextToSize(l, CONTENT_W));

  const dateText = formatEventDate(opts.eventDate);
  const headerH = logoImg ? 110 : 90;

  // Altura do bloco de detalhes (titular/tipo/data/local/valor)
  let detailsH = 46 + 46; // titular + tipo
  if (dateText) detailsH += 40;
  if (locLines.length) detailsH += 16 + locLines.length * 14 + 12;
  detailsH += 46; // valor pago

  // Bloco QR + código + link
  const qrH = (qrImg ? 120 : 0) + 20 + 16 + 24;

  // Bloco devolução/cancelamento
  const refundH = refundLines.length ? 14 + refundLines.length * 12 + 18 : 0;

  // Bloco patrocinadores: rótulo do nível + linhas de caixas (3 por linha)
  let sponsorsH = 0;
  for (const g of groups) {
    const rows = Math.ceil(g.items.length / 3);
    sponsorsH += 16 + rows * (SPONSOR_BOX_H + 10);
  }
  if (sponsorsH) sponsorsH += 10;

  // Bloco recibo
  const receiptRows =
    (opts.paidAt ? 1 : 0) + (opts.paymentMethod ? 1 : 0) + (opts.receiverName ? 1 : 0) + (opts.receiverDoc ? 1 : 0);
  const receiptH = hasReceipt ? 24 + 14 + receiptRows * 13 + 10 : 0;

  const pageH = Math.ceil(headerH + 30 + detailsH + 10 + qrH + refundH + sponsorsH + receiptH + 30);
  const doc = new jsPDF({ unit: 'pt', format: [W, pageH] });

  // ===== Header (banda escura + logo do evento) =====
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, W, headerH, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text((opts.eventName || 'Evento').slice(0, 42), M, 38, { maxWidth: logoImg ? 240 : 320 });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text('INGRESSO', M, 58);
  if (logoImg) {
    try {
      const props = doc.getImageProperties(logoImg.data);
      const maxW = 56, maxH = 56;
      const scale = Math.min(maxW / props.width, maxH / props.height);
      const w = props.width * scale, h = props.height * scale;
      doc.addImage(logoImg.data, logoImg.format, W - M - w, 16, w, h);
    } catch (err: any) {
      console.error('[ticketPdf] logo draw failed:', err?.message || err);
    }
  }

  // ===== Detalhes =====
  doc.setTextColor(15, 23, 42);
  let y = headerH + 30;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Titular', M, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  doc.text(String(opts.holderName || '—').slice(0, 46), M, y + 16);
  y += 46;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Tipo', M, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  doc.text(`${opts.ticketTypeName || 'Ingresso'}${opts.lotName ? ' — ' + opts.lotName : ''}`.slice(0, 46), M, y + 16);
  y += 46;

  if (dateText) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Data', M, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(12);
    doc.text(dateText, M, y + 16, { maxWidth: CONTENT_W });
    y += 40;
  }
  if (locLines.length) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Local', M, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(12);
    locLines.forEach((line, i) => doc.text(line, M, y + 16 + i * 14));
    y += 16 + locLines.length * 14 + 12;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Valor pago', M, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(14);
  doc.text(`R$ ${Number(opts.pricePaid || 0).toFixed(2)}`, M, y + 16);
  y += 46 + 10;

  // ===== QR code + código + link do app =====
  let qrY = y;
  if (qrImg) {
    try {
      doc.addImage(qrImg.data, qrImg.format, (W - 120) / 2, qrY, 120, 120);
    } catch (err: any) {
      console.error('[ticketPdf] QR draw failed:', err?.message || err);
    }
    qrY += 120;
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text(`Código: ${opts.hashCode}`, W / 2, qrY + 10, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(`Acesse o app: ${opts.appUrl}`, W / 2, qrY + 26, { align: 'center', maxWidth: 340 });
  y = qrY + 16 + 24;

  // ===== Política de devolução/cancelamento do evento =====
  if (refundLines.length) {
    doc.setDrawColor(226, 232, 240);
    doc.line(M, y, W - M, y);
    y += 20;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text('DEVOLUÇÃO E CANCELAMENTO', M, y);
    y += 14;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(71, 85, 105);
    refundLines.forEach((line) => {
      doc.text(line, M, y);
      y += 12;
    });
    y += 18;
  }

  // ===== Patrocinadores por nível =====
  for (const g of groups) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(TIER_LABELS[g.tier] || String(g.tier).toUpperCase(), M, y);
    y += 16;
    for (let i = 0; i < g.items.length; i++) {
      const s = g.items[i];
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = M + col * (SPONSOR_BOX_W + SPONSOR_GAP);
      const by = y + row * (SPONSOR_BOX_H + 10);
      let drawn = false;
      if (s.img) {
        try {
          const props = doc.getImageProperties(s.img.data);
          const scale = Math.min(SPONSOR_BOX_W / props.width, SPONSOR_BOX_H / props.height);
          const w = props.width * scale, h = props.height * scale;
          doc.addImage(s.img.data, s.img.format, x + (SPONSOR_BOX_W - w) / 2, by + (SPONSOR_BOX_H - h) / 2, w, h);
          drawn = true;
        } catch {
          // cai para o nome em texto
        }
      }
      if (!drawn) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(15, 23, 42);
        const nameLines = doc.splitTextToSize(String(s.name || '').slice(0, 40), SPONSOR_BOX_W).slice(0, 2);
        for (let li = 0; li < nameLines.length; li++) {
          doc.text(nameLines[li], x + SPONSOR_BOX_W / 2, by + 14 + li * 9, { align: 'center' });
        }
      }
    }
    const rows = Math.ceil(g.items.length / 3);
    y += rows * (SPONSOR_BOX_H + 10);
  }

  // ===== Recibo — valor, data, forma de pagamento e recebedor (organizador) =====
  if (hasReceipt) {
    doc.setDrawColor(226, 232, 240);
    doc.line(M, y, W - M, y);
    y += 24;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text('RECIBO', M, y);
    doc.setTextColor(15, 23, 42);
    y += 14;
    doc.setFont('helvetica', 'normal');
    if (opts.paidAt) {
      try {
        doc.text(`Data do pagamento: ${new Date(opts.paidAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`, M, y, { maxWidth: CONTENT_W });
      } catch {
        doc.text(`Data do pagamento: ${String(opts.paidAt)}`, M, y, { maxWidth: CONTENT_W });
      }
      y += 13;
    }
    if (opts.paymentMethod) {
      doc.text(`Forma de pagamento: ${PAYMENT_METHOD_LABELS[opts.paymentMethod] || opts.paymentMethod}`, M, y, { maxWidth: CONTENT_W });
      y += 13;
    }
    if (opts.receiverName) {
      doc.text(`Recebedor: ${String(opts.receiverName).slice(0, 60)}`, M, y, { maxWidth: CONTENT_W });
      y += 13;
    }
    if (opts.receiverDoc) {
      doc.text(`CNPJ: ${String(opts.receiverDoc)}`, M, y, { maxWidth: CONTENT_W });
    }
  }

  return new Uint8Array(doc.output('arraybuffer') as ArrayBuffer);
}

// Monta os extras do PDF a partir do evento: logo, patrocinadores ativos por
// nível e política de devolução (premissas do evento, com defaults globais).
// Usado por getTicketPdf (download) e deliverTickets (fulfillment) — sem duplicar lógica.
export async function buildTicketPdfExtras(svc: any, event: any): Promise<{ eventLogoUrl: string; sponsors: TicketSponsor[]; refundPolicyLines: string[] }> {
  const extras: { eventLogoUrl: string; sponsors: TicketSponsor[]; refundPolicyLines: string[] } = {
    eventLogoUrl: event?.logo_url || '',
    sponsors: [],
    refundPolicyLines: [],
  };
  if (!event?.id) return extras;

  // Patrocinadores ativos, agrupados por nível no PDF
  try {
    const eventPartners = await svc.entities.EventPartner.filter({ event_id: event.id, is_active: true, is_deleted: false });
    const partnerIds = [...new Set(eventPartners.map((ep: any) => ep.partner_id).filter(Boolean))];
    const partners = await Promise.all(
      partnerIds.map(async (pid: string) => {
        try { return (await svc.entities.Partner.filter({ id: pid }))[0] || null; } catch { return null; }
      })
    );
    const byId = new Map(partners.filter(Boolean).map((p: any) => [p.id, p]));
    extras.sponsors = eventPartners
      .map((ep: any) => {
        const p = byId.get(ep.partner_id);
        return {
          name: p?.trade_name || p?.legal_name || '',
          logoUrl: p?.logo_url || '',
          tier: ep.sponsorship_plan,
        };
      })
      .filter((s: any) => s.name);
  } catch (err: any) {
    console.error('[ticketPdf] sponsors load failed:', err?.message || err);
  }

  // Política de devolução/cancelamento do evento (override sobre o default global)
  try {
    let override: any = {};
    try { override = event.refund_policy ? JSON.parse(event.refund_policy) : {}; } catch {}
    const policy = { ...DEFAULT_GLOBAL_REFUND_POLICY, ...override };
    const lines = [
      `• Devolução integral: solicitada até ${policy.full_refund_until_days} dia(s) antes do início do evento.`,
      `• Devolução parcial de ${policy.partial_refund_percent}% do valor pago: entre ${policy.no_refund_within_days} e ${policy.full_refund_until_days} dia(s) antes do evento.`,
      `• Sem devolução a menos de ${policy.no_refund_within_days} dia(s) do início do evento.`,
    ];
    if (policy.allow_manual_override) {
      lines.push('• Solicitações fora destas condições podem ser avaliadas pelo organizador.');
    }
    if (event.start_date) {
      try {
        const deadline = new Date(new Date(event.start_date).getTime() - policy.full_refund_until_days * 24 * 60 * 60 * 1000);
        lines.push(`• Prazo para devolução integral: ${deadline.toLocaleDateString('pt-BR')}.`);
      } catch {}
    }
    extras.refundPolicyLines = lines;
  } catch (err: any) {
    console.error('[ticketPdf] refund policy load failed:', err?.message || err);
  }

  return extras;
}

const APP_URL = 'https://app.evolveinst.com';

// Entrega os ingressos: gera PDF (com QR), envia por email ao titular com o PDF
// anexado (base64). Idempotente — pula ingressos que já têm pdf_url.
export async function deliverTickets(svc: any, event: any, order: any, tickets: any[], orderItems: any[]): Promise<void> {
  // Extras do evento (logo, patrocinadores, política de devolução) — comuns a todos os ingressos.
  const extras = await buildTicketPdfExtras(svc, event).catch(() => ({ eventLogoUrl: '', sponsors: [], refundPolicyLines: [] }));

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
        eventLogoUrl: extras.eventLogoUrl,
        holderName: item.holder_name,
        ticketTypeName: item.ticket_type_name,
        lotName: '',
        pricePaid: item.unit_price,
        hashCode: ticket.hash_code,
        appUrl: APP_URL,
        sponsors: extras.sponsors,
        refundPolicyLines: extras.refundPolicyLines,
        paidAt: receipt.paidAt,
        paymentMethod: receipt.paymentMethod,
        receiverName: receipt.receiverName,
        receiverDoc: receipt.receiverDoc,
      });
      // Upload de arquivos gerados no backend não é suportado pela integração
      // (exige multipart) — o PDF vai como anexo base64 do próprio e-mail.
      let b64 = '';
      try {
        let s = '';
        for (let i = 0; i < pdfBytes.length; i += 0x8000) {
          s += String.fromCharCode(...pdfBytes.subarray(i, i + 0x8000));
        }
        b64 = btoa(s);
      } catch (encErr: any) {
        console.error('[deliverTickets] base64 encode failed:', encErr?.message || encErr);
      }
      if (item.holder_email) {
        const body =
          `Olá ${item.holder_name},\n\nSeu ingresso para "${event?.name || 'Evento'}" foi confirmado!\n\n` +
          `Titular: ${item.holder_name}\nTipo: ${item.ticket_type_name}\nValor: R$ ${Number(item.unit_price).toFixed(2)}\n` +
          `Código: ${ticket.hash_code}\n\n` +
          `O ingresso em PDF (com QR code para o check-in) está anexado a este e-mail.\n\n` +
          `Acesse o app: ${APP_URL}\n\nEvolve Summit`;
        const emailPayload: any = {
          to: item.holder_email,
          subject: `Ingresso — ${event?.name || 'Evento'}`,
          body,
        };
        if (b64) {
          emailPayload.attachments = [{ filename: `ingresso-${ticket.hash_code}.pdf`, content: b64 }];
        }
        await svc.integrations.Core.SendEmail(emailPayload);
      }
    } catch (err: any) {
      console.error('[deliverTickets] failed for ticket', ticket.id, err?.message || err);
    }
  }
}