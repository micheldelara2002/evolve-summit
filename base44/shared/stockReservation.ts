// F4-01 (AUD-01) — RESERVA DE ESTOQUE IDENTIFICÁVEL, ASSOCIADA E RECUPERÁVEL.
//
// PROBLEMA CORRIGIDO: o checkout reservava estoque com `$inc` em
// `SalesLot.quantity_reserved` e, se qualquer passo seguinte falhasse (criação
// do pedido, criação dos itens, cobrança no provedor, trilha), o estoque podia
// ficar comprometido SEM pedido correspondente — reserva órfã: invisível nos
// pedidos, não devolvida por nenhum caminho e sem forma de identificar de quem
// era. O lote parecia esgotado para sempre.
//
// LIMITAÇÃO DA PLATAFORMA (declarada, não contornada): não existe transação
// entre documentos. A única escrita atômica disponível é POR DOCUMENTO. Por isso
// a garantia vive no MESMO documento que é incrementado/decrementado:
//
//   1. Cada tentativa de checkout recebe um TOKEN gerado no SERVIDOR
//      (`checkoutToken`). O cliente nunca escolhe token.
//   2. A reserva de um lote incrementa a quantidade E grava o token na MESMA
//      escrita (`$inc quantity_reserved` + `$addToSet reservation_tokens`) com
//      a guarda de estoque (`$lte`). Não existe janela em que a quantidade foi
//      reservada sem o token correspondente.
//   3. A liberação é um CAS POR TOKEN:
//        { id: lote, reservation_tokens: token } + $inc -qty + $pull token
//      ⇒ exatamente um decremento por token; repetir é no-op (`updated: 0`);
//      nenhum checkout libera a reserva de outro; a quantidade nunca fica
//      negativa por liberação alheia.
//   4. `StockReservation` é o registro DURÁVEL de metadados (identificação,
//      evento, comprador, lote, quantidade, validade, pedido e estado). Ele não
//      é a exclusão mútua — quem impede o duplo decremento é o token no lote —
//      mas é o que torna a reserva encontrável para reconciliação e auditoria.
//
// ESTADOS DO REGISTRO: claiming (gravado, estoque ainda não aplicado) →
// active (estoque reservado) → released (devolvido) | consumed (venda
// confirmada). Um registro `claiming` cujo token não está no lote significa que
// a escrita de estoque não aconteceu: a liberação não decrementa nada e apenas
// encerra o registro (fail-safe, sem perder nem roubar unidade).
//
// CONSEQUÊNCIA ACEITA: um crash entre a criação do registro e a escrita do lote
// deixa o registro em `claiming` por até a validade; a reconciliação o encerra
// sem tocar o estoque (porque o CAS por token não casa). Nenhum caminho libera
// estoque por idade sem antes verificar token, pedido e pagamentos.
//
// ===== F4-02 (P1) — O PAGAMENTO É CONSULTADO NO PROVEDOR, NÃO SÓ NO BANCO =====
//
// DEFEITO CORRIGIDO: o reconciler de estoque olhava apenas `Payment.status`
// local. Um PaymentIntent em `processing` (Pix compensando) ou já `succeeded`
// cujo webhook ainda não chegou era tratado como "sem pagamento" e a reserva era
// devolvida — enquanto o expirador de pedidos, no MESMO run, mantinha o pedido
// vivo por consultar o Stripe. Dois reconciliadores, duas decisões opostas.
//
// Correção: uma única função de decisão (`assessOrderPaymentState`) consulta o
// provedor e classifica o pagamento em pago / processando / indeterminado /
// ativo no provedor / nenhum pagamento vivo. Os dois reconciliadores usam essa
// MESMA decisão (`isPaymentProtected`). Sem prova de ausência de pagamento
// (provedor indisponível, resposta inconclusiva, leitura local falhou) NADA é
// liberado: a reserva fica e a próxima execução tenta de novo.
//
// ===== F4-02 (P2) — CONVERSÃO reservado→vendido EXATAMENTE UMA VEZ =====
//
// DEFEITO CORRIGIDO: `consumeReservation` removia o token e encerrava a reserva
// assim que via pagamento confirmado, mesmo com fulfillment incompleto. Sem
// token, nenhum caminho conseguia mais devolver nem converter aquelas unidades:
// o estoque ficava preso em `quantity_reserved` para sempre.
//
// Correção: a conversão por item de pedido é um CAS idempotente no PRÓPRIO lote
// (`stock_converted_order_item_ids`), na mesma escrita do `$inc` — retomável sem
// duplicar `quantity_sold`. O encerramento da reserva (`consumed`) só acontece
// quando TODAS as unidades daquele lote já foram convertidas. Pagamento
// confirmado com estoque não convertido mantém a reserva VIVA (e o token no
// lote) para a retomada.

import { retrievePaymentIntent } from "./stripeClient.ts";

export const STOCK_RESERVATION_TTL_MS = 15 * 60 * 1000;
const ENTITY = "StockReservation";

// Token de tentativa de checkout — SEMPRE gerado no servidor.
export function newCheckoutToken(prefix = "ck"): string {
  const uuid = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${uuid}`;
}

// Transição de estado por CAS (nunca sobrescreve estado já terminal).
async function transition(svc: any, id: string, fromStates: string[], state: string, extra: Record<string, any> = {}): Promise<boolean> {
  if (!id) return false;
  try {
    const res = await svc.entities[ENTITY].updateMany(
      { id, state: { $in: fromStates } },
      { $set: { state, ...extra } },
    );
    return !!(res && res.updated);
  } catch (err: any) {
    console.error("[stockReservation] transição de estado falhou:", err?.message || err);
    return false;
  }
}

// RESERVA: registro durável + escrita atômica no lote, lote por lote.
// Em qualquer falha, o que já foi reservado NESTA tentativa é devolvido por
// token (idempotente) antes de responder — nada fica preso.
export async function reserveStockForCheckout(
  svc: any,
  params: {
    checkoutToken: string;
    eventId: string;
    userId?: string;
    demandByLot: Record<string, number>;
    lotById: Record<string, any>;
    ttlMs?: number;
  },
): Promise<{ ok: boolean; reason: string; failedLot?: string; reserved?: any[] }> {
  const checkoutToken = String(params?.checkoutToken || "");
  const eventId = String(params?.eventId || "");
  const demandByLot = params?.demandByLot || {};
  const lotById = params?.lotById || {};
  if (!checkoutToken || !eventId) return { ok: false, reason: "identidade_ausente" };

  const expiresAt = new Date(Date.now() + (Number(params.ttlMs) || STOCK_RESERVATION_TTL_MS)).toISOString();
  const reserved: any[] = [];

  for (const lotId of Object.keys(demandByLot)) {
    const lot = lotById[lotId] || {};
    const qty = Math.max(1, Number(demandByLot[lotId]) || 1);

    // (1) Registro DURÁVEL primeiro (estado 'claiming'): a reserva passa a ser
    // identificável e encontrável antes de qualquer escrita de estoque.
    let record: any = null;
    try {
      record = await svc.entities[ENTITY].create({
        event_id: eventId,
        checkout_token: checkoutToken,
        user_id: String(params.userId || ""),
        order_id: "",
        lot_id: lotId,
        quantity: qty,
        state: "claiming",
        expires_at: expiresAt,
        is_deleted: false,
      });
    } catch (err: any) {
      console.error("[stockReservation] registro da reserva não gravado:", err?.message || err);
    }
    if (!record?.id) {
      // Sem identificação durável a reserva NÃO começa (fail-closed).
      await releaseCheckoutReservations(svc, checkoutToken, "record_unavailable");
      return { ok: false, reason: "registro_indisponivel", failedLot: lotId };
    }

    // (2) Escrita atômica: quantidade + token no MESMO documento, com guarda.
    const threshold = (Number(lot.quantity_total) || 0) - (Number(lot.quantity_sold) || 0) - qty;
    let updated = 0;
    try {
      const res = await svc.entities.SalesLot.updateMany(
        { id: lotId, quantity_reserved: { $lte: threshold } },
        { $inc: { quantity_reserved: qty }, $addToSet: { reservation_tokens: checkoutToken } },
      );
      updated = res && res.updated ? res.updated : 0;
    } catch (err: any) {
      console.error("[stockReservation] reserva de estoque falhou:", err?.message || err);
    }
    if (!updated) {
      // Lote esgotou em corrida: encerra o registro desta tentativa e devolve
      // os lotes já reservados (por token).
      await transition(svc, record.id, ["claiming"], "released", { released_reason: "lot_unavailable" });
      await releaseCheckoutReservations(svc, checkoutToken, "lot_unavailable");
      return { ok: false, reason: "lot_unavailable", failedLot: lotId };
    }
    await transition(svc, record.id, ["claiming"], "active");
    reserved.push({ id: record.id, lot_id: lotId, quantity: qty, checkout_token: checkoutToken });
  }

  return { ok: true, reason: "", reserved };
}

// LIBERAÇÃO por token — o coração da idempotência.
// Só o dono do token devolve estoque, e só uma vez. Se o token não está no
// lote (já liberado, consumido, ou nunca aplicado), NENHUM decremento acontece.
export async function releaseReservation(svc: any, record: any, reason: string): Promise<{ released: boolean; reason: string }> {
  const token = String(record?.checkout_token || "");
  const lotId = String(record?.lot_id || "");
  const qty = Math.abs(Number(record?.quantity) || 0);
  if (!token || !lotId || qty <= 0) {
    return { released: false, reason: "reserva_sem_identidade" };
  }

  let released = false;
  try {
    // Guarda adicional `quantity_reserved >= qty`: nem um registro com
    // quantidade inflada (dado legado/corrompido) consegue drenar o lote ou
    // deixar a quantidade negativa — nesse caso nada é decrementado e o
    // registro é apenas encerrado.
    const res = await svc.entities.SalesLot.updateMany(
      { id: lotId, reservation_tokens: token, quantity_reserved: { $gte: qty } },
      { $inc: { quantity_reserved: -qty }, $pull: { reservation_tokens: token } },
    );
    released = !!(res && res.updated);
  } catch (err: any) {
    console.error("[stockReservation] liberação de estoque falhou:", err?.message || err);
    return { released: false, reason: `liberacao_indisponivel:${err?.message || err}` };
  }

  // O estado é sempre encerrado — mesmo quando o token já não estava no lote
  // (nada a devolver). O motivo registra se houve devolução real.
  await transition(svc, record.id, ["claiming", "active"], "released", {
    released_reason: released ? reason : `${reason}:sem_estoque`,
  });
  return { released, reason };
}

// Devolve TODAS as reservas vivas de uma tentativa de checkout (falha
// intermediária do próprio checkout). Idempotente.
export async function releaseCheckoutReservations(
  svc: any,
  checkoutToken: string,
  reason: string,
): Promise<{ released: number; examined: number }> {
  const token = String(checkoutToken || "");
  if (!token) return { released: 0, examined: 0 };
  let records: any[] = [];
  try {
    records = await svc.entities[ENTITY].filter({
      checkout_token: token,
      state: { $in: ["claiming", "active"] },
      is_deleted: false,
    });
  } catch (err: any) {
    console.error("[stockReservation] consulta de reservas do checkout falhou:", err?.message || err);
    return { released: 0, examined: 0 };
  }
  let released = 0;
  for (const rec of records || []) {
    const out = await releaseReservation(svc, rec, reason);
    if (out.released) released++;
  }
  return { released, examined: (records || []).length };
}

// Devolve as reservas de UM item de pedido (usado na expiração/cancelamento e
// no re-checkout). Retorna true quando o item TEM reserva identificada — nesse
// caso o caminho legado (decremento guardado por item) NÃO roda, porque o token
// é a autoridade.
export async function releaseReservationsForOrderItem(svc: any, item: any, reason: string): Promise<boolean> {
  if (!item?.order_id || !item?.lot_id) return false;
  let records: any[] = [];
  try {
    records = await svc.entities[ENTITY].filter({
      order_id: item.order_id,
      lot_id: item.lot_id,
      state: { $in: ["claiming", "active"] },
      is_deleted: false,
    });
  } catch (err: any) {
    console.error("[stockReservation] consulta de reservas do item falhou:", err?.message || err);
    return false;
  }
  if (!records || records.length === 0) return false;
  for (const rec of records) await releaseReservation(svc, rec, reason);
  return true;
}

// Liga as reservas da tentativa ao pedido criado/reutilizado.
export async function attachReservationsToOrder(svc: any, checkoutToken: string, orderId: string): Promise<{ attached: number }> {
  if (!checkoutToken || !orderId) return { attached: 0 };
  try {
    const res = await svc.entities[ENTITY].updateMany(
      { checkout_token: checkoutToken, order_id: "" },
      { $set: { order_id: orderId } },
    );
    return { attached: res && res.updated ? res.updated : 0 };
  } catch (err: any) {
    console.error("[stockReservation] associação ao pedido falhou:", err?.message || err);
    return { attached: 0 };
  }
}

// ===== F4-02 (P2) — CONVERSÃO reservado→vendido, EXATAMENTE UMA VEZ =====
// Cada item de pedido converte UMA unidade do lote (reservado→vendido). O
// marcador `stock_converted_order_item_ids` entra na MESMA escrita do `$inc`:
//   • repetir é no-op (o item já está no marcador) — retry e reconciliação não
//     duplicam `quantity_sold`;
//   • interrupção não deixa estado intermediário (ou converteu e marcou, ou
//     nada aconteceu) — a retomada não depende de memória da execução anterior.
export async function convertReservedToSoldOnce(
  svc: any,
  item: any,
): Promise<{ converted: boolean; reason: string }> {
  const lotId = String(item?.lot_id || "");
  const itemId = String(item?.id || "");
  if (!lotId || !itemId) return { converted: false, reason: "item_sem_identidade" };

  let updated = 0;
  try {
    // F4-03 — a escrita exige, no MESMO filtro, que o item ainda não esteja
    // convertido E que exista unidade RESERVADA a converter. Sem a segunda
    // condição, um lote com `quantity_reserved` zerado (ou ausente) iria a
    // negativo e `quantity_sold` subiria sem reserva correspondente.
    const res = await svc.entities.SalesLot.updateMany(
      {
        id: lotId,
        stock_converted_order_item_ids: { $ne: itemId },
        quantity_reserved: { $gte: 1 },
      },
      { $inc: { quantity_reserved: -1, quantity_sold: 1 }, $addToSet: { stock_converted_order_item_ids: itemId } },
    );
    updated = res && res.updated ? res.updated : 0;
  } catch (err: any) {
    console.error("[stockReservation] conversão reservado→vendido falhou:", itemId, err?.message || err);
    return { converted: false, reason: "conversao_indisponivel" };
  }
  if (updated) return { converted: true, reason: "convertido" };

  // Zero atualização não prova nada: o item pode já ter sido convertido (retry),
  // o lote pode não existir ou pode não haver estoque reservado. A confirmação
  // vem da LEITURA do lote — nunca da resposta do update.
  let lot: any = null;
  try {
    lot = (await svc.entities.SalesLot.filter({ id: lotId }))[0] || null;
  } catch (err: any) {
    return { converted: false, reason: "leitura_indisponivel" };
  }
  if (!lot) return { converted: false, reason: "lote_inexistente" };
  const marked = Array.isArray(lot.stock_converted_order_item_ids) && lot.stock_converted_order_item_ids.includes(itemId);
  if (marked) return { converted: false, reason: "ja_convertido" };
  if ((Number(lot.quantity_reserved) || 0) < 1) return { converted: false, reason: "reservado_insuficiente" };
  return { converted: false, reason: "conversao_nao_aplicada" };
}

// F4-03 — o pedido tem reserva de estoque IDENTIFICADA? Decide se uma falha de
// conversão bloqueia o fulfillment (lote inexistente incluso). Leitura
// indisponível LANÇA: tratar erro como "pedido legado" concluiria o pedido com
// estoque não convertido — o chamador fica em pending_retry e retoma.
export async function orderTracksStockReservations(svc: any, orderId: string): Promise<boolean> {
  if (!orderId) return false;
  const rows = await svc.entities[ENTITY].filter({ order_id: orderId, is_deleted: false });
  return Array.isArray(rows) && rows.length > 0;
}

async function listOrderReservations(svc: any, orderId: string, states?: string[]): Promise<any[]> {
  if (!orderId) return [];
  const query: any = { order_id: orderId, is_deleted: false };
  if (states && states.length > 0) query.state = { $in: states };
  try {
    return (await svc.entities[ENTITY].filter(query)) || [];
  } catch (err: any) {
    console.error("[stockReservation] consulta de reservas do pedido falhou:", err?.message || err);
    return [];
  }
}

// Unidades daquele lote/pedido que JÁ foram convertidas (marcador no lote).
async function convertedUnitsFor(svc: any, orderId: string, lotId: string): Promise<number> {
  if (!orderId || !lotId) return 0;
  let items: any[] = [];
  let lot: any = null;
  try {
    items = await svc.entities.OrderItem.filter({ order_id: orderId, is_deleted: false }) || [];
    lot = (await svc.entities.SalesLot.filter({ id: lotId }))[0] || null;
  } catch (err: any) {
    console.error("[stockReservation] verificação de conversão falhou:", orderId, lotId, err?.message || err);
    return 0;
  }
  const marked = Array.isArray(lot?.stock_converted_order_item_ids) ? lot.stock_converted_order_item_ids : [];
  const itemIds = (items || []).filter((i: any) => String(i.lot_id || "") === String(lotId)).map((i: any) => String(i.id));
  return itemIds.filter((id: string) => marked.includes(id)).length;
}

// ENCERRAMENTO por venda confirmada: as unidades JÁ viraram vendidas (conversão
// item a item); aqui o token sai do lote (sem decremento) e o registro passa a
// 'consumed', estado terminal. Nenhuma reconciliação pode devolver esse estoque
// depois. F4-02: só roda quando a conversão daquele lote está COMPLETA.
async function consumeReservation(svc: any, record: any): Promise<boolean> {
  const token = String(record?.checkout_token || "");
  const lotId = String(record?.lot_id || "");
  if (token && lotId) {
    try {
      await svc.entities.SalesLot.updateMany(
        { id: lotId, reservation_tokens: token },
        { $pull: { reservation_tokens: token } },
      );
    } catch (err: any) {
      console.error("[stockReservation] remoção do token do lote falhou:", err?.message || err);
    }
  }
  return transition(svc, record.id, ["claiming", "active"], "consumed");
}

// Encerra a reserva SOMENTE com as unidades do lote integralmente convertidas.
// Caso contrário a reserva (e o token no lote) permanece VIVA para a retomada.
async function consumeReservationIfFullyConverted(
  svc: any,
  record: any,
  orderId: string,
): Promise<{ consumed: boolean; converted: number; needed: number }> {
  const needed = Math.abs(Number(record?.quantity) || 0);
  const converted = await convertedUnitsFor(svc, orderId || String(record?.order_id || ""), String(record?.lot_id || ""));
  if (converted < needed) return { consumed: false, converted, needed };
  return { consumed: await consumeReservation(svc, record), converted, needed };
}

// RETOMADA da conversão: para pedidos com reserva identificada, converte o que
// ficou pendente de uma execução interrompida — sempre por CAS no marcador, sem
// duplicar `quantity_sold`. Só converte item que JÁ tem ingresso emitido:
// converter sem ingresso venderia uma unidade que ninguém recebeu.
// Pedidos legados (sem StockReservation) não passam por aqui.
//
// F4-04 — NENHUM RESULTADO NÃO CONFIRMADO É TRATADO COMO CONCLUÍDO:
//   • falha de leitura (reservas, itens ou ingressos) devolve `unavailable: true`;
//     `pending: 0` com `unavailable` NÃO significa "nada a fazer" — o chamador
//     precisa bloquear em vez de concluir o pedido;
//   • `lote_inexistente`, `reservado_insuficiente`, `conversao_indisponivel`,
//     `leitura_indisponivel`, `conversao_nao_aplicada` e item sem ingresso
//     permanecem PENDENTES, com o motivo em `reasons`;
//   • só `convertido` e `ja_convertido` contam como concluídos — e `ja_convertido`
//     vem da LEITURA do marcador no lote, nunca da resposta da escrita.
export async function resumeOrderStockConversion(
  svc: any,
  orderId: string,
): Promise<{ converted: number; pending: number; unavailable: boolean; reasons: string[]; legacy: boolean }> {
  if (!orderId) return { converted: 0, pending: 0, unavailable: false, reasons: [], legacy: true };

  // Leitura das reservas com erro EXPLÍCITO: `listOrderReservations` devolve []
  // em falha, e isso seria confundido com "pedido legado" — exatamente o que a
  // retomada de um pagamento confirmado não pode fazer.
  let records: any[] = [];
  try {
    records = (await svc.entities[ENTITY].filter({ order_id: orderId, is_deleted: false })) || [];
  } catch (err: any) {
    console.error("[stockReservation] reservas do pedido ilegíveis:", orderId, err?.message || err);
    return { converted: 0, pending: 0, unavailable: true, reasons: ["reservas_indisponiveis"], legacy: false };
  }
  if (records.length === 0) return { converted: 0, pending: 0, unavailable: false, reasons: [], legacy: true };

  const reservedLots = new Set(records.map((r: any) => String(r.lot_id || "")));
  let items: any[] = [];
  let tickets: any[] = [];
  try {
    items = (await svc.entities.OrderItem.filter({ order_id: orderId, is_deleted: false })) || [];
    tickets = (await svc.entities.Ticket.filter({ order_id: orderId, is_deleted: false })) || [];
  } catch (err: any) {
    console.error("[stockReservation] retomada de conversão indisponível:", orderId, err?.message || err);
    return { converted: 0, pending: 0, unavailable: true, reasons: ["itens_ou_ingressos_indisponiveis"], legacy: false };
  }

  let converted = 0;
  let pending = 0;
  const reasons: string[] = [];
  for (const item of items || []) {
    if (!reservedLots.has(String(item.lot_id || ""))) continue;
    const hasTicket = (tickets || []).some((t: any) => t.order_item_id === item.id && !t.is_deleted);
    if (!hasTicket) {
      pending++;
      reasons.push(`${item.id}:sem_ingresso`);
      continue;
    }
    const out = await convertReservedToSoldOnce(svc, item);
    if (out.converted || out.reason === "ja_convertido") { converted++; continue; }
    pending++;
    reasons.push(`${item.id}:${out.reason}`);
  }
  return { converted, pending, unavailable: false, reasons, legacy: false };
}

// Encerra as reservas do pedido — apenas as que já estão integralmente
// convertidas. As demais continuam vivas (F4-02/P2).
export async function consumeOrderReservations(svc: any, orderId: string): Promise<{ consumed: number; pending: number }> {
  if (!orderId) return { consumed: 0, pending: 0 };
  const records = await listOrderReservations(svc, orderId, ["claiming", "active"]);
  let consumed = 0;
  let pending = 0;
  for (const rec of records) {
    const out = await consumeReservationIfFullyConverted(svc, rec, orderId);
    if (out.consumed) consumed++;
    else pending++;
  }
  return { consumed, pending };
}

async function auditRelease(svc: any, record: any, reason: string, released: boolean) {
  try {
    await svc.entities.AuditLog.create({
      action: "update",
      entity_type: ENTITY,
      entity_id: record.id,
      user_id: "system",
      user_name: "Manutenção automática",
      event_id: record.event_id || "",
      details: JSON.stringify({
        type: released ? "stock_reservation_released" : "stock_reservation_cleared",
        reason,
        checkout_token: record.checkout_token,
        order_id: record.order_id || "",
        lot_id: record.lot_id,
        quantity: record.quantity,
      }),
    });
  } catch { /* trilha é best-effort aqui: a garantia está no token do lote */ }
}

// ===== F4-02 (P1) — DECISÃO ÚNICA DE PROTEÇÃO DO PAGAMENTO =====
//
// Usada pelos DOIS reconciliadores (expiração de pedidos e reservas de estoque)
// para que nunca decidam de forma oposta na mesma execução. O banco local não é
// prova de ausência de pagamento: um intent em `processing` (Pix) ou já pago
// sem webhook continua sendo dinheiro real.
export type PaymentGuardVerdict =
  | "pago"
  | "processando"
  | "indeterminado"
  | "ativo_no_provedor"
  | "nenhum_pagamento_vivo";

export type PaymentGuard = {
  verdict: PaymentGuardVerdict;
  reason: string;
  paid_payment_id?: string;
  pending_intents: Array<{ payment_id: string; intent_id: string; provider: "stripe" | "local"; status: string }>;
};

// Pagamento local que já prova dinheiro (confirmado, em emissão ou estornado).
function isLiveLocalPayment(p: any): boolean {
  return p.status === "succeeded"
    || p.status === "refunded"
    || p.status === "partially_refunded"
    || p.fulfillment_status === "pending_retry"
    || p.fulfillment_status === "fulfilled"
    || p.fulfillment_status === "fulfilling";
}

export async function assessOrderPaymentState(
  svc: any,
  orderOrId: any,
  options: { retrieveIntent?: (intentId: string) => Promise<any> } = {},
): Promise<PaymentGuard> {
  const retrieveIntent = options.retrieveIntent || retrievePaymentIntent;
  const orderId = typeof orderOrId === "string" ? orderOrId : String(orderOrId?.id || "");
  if (!orderId) return { verdict: "indeterminado", reason: "pedido_sem_identidade", pending_intents: [] };

  let payments: any[] = [];
  try {
    payments = (await svc.entities.Payment.filter({ order_id: orderId, is_deleted: false })) || [];
  } catch (err: any) {
    // Leitura indisponível NÃO é ausência de pagamento (fail-closed).
    console.error("[stockReservation] leitura de pagamentos falhou:", orderId, err?.message || err);
    return { verdict: "indeterminado", reason: "pagamentos_ilegiveis", pending_intents: [] };
  }
  if (payments.length === 0) {
    return { verdict: "nenhum_pagamento_vivo", reason: "pedido_sem_pagamento", pending_intents: [] };
  }

  const paid = payments.find(isLiveLocalPayment);
  if (paid) {
    const detail = paid.fulfillment_status ? `${paid.status}/${paid.fulfillment_status}` : String(paid.status || "");
    return { verdict: "pago", reason: `pagamento_local:${detail}`, paid_payment_id: paid.id, pending_intents: [] };
  }

  const pendingIntents: PaymentGuard["pending_intents"] = [];
  let verdict: PaymentGuardVerdict = "nenhum_pagamento_vivo";
  let reason = "nenhum_intent_vivo";

  for (const p of payments.filter((x: any) => x.status === "pending")) {
    const intentId = String(p.intent_id || "");
    if (!intentId || intentId.startsWith("free_")) {
      if (String(p.provider || "") === "stripe" && !intentId) {
        // Sem intent registrado não há o que consultar — e não consultar NÃO é
        // prova de ausência de pagamento (comportamento anterior preservado).
        return { verdict: "indeterminado", reason: "intent_ausente", pending_intents: pendingIntents };
      }
      pendingIntents.push({ payment_id: p.id, intent_id: intentId, provider: "local", status: "sem_provedor" });
      continue;
    }
    let payload: any = null;
    try {
      payload = await retrieveIntent(intentId);
    } catch (err: any) {
      console.error("[stockReservation] consulta ao provedor falhou:", intentId, err?.message || err);
      return { verdict: "indeterminado", reason: "provedor_indisponivel", pending_intents: pendingIntents };
    }
    const status = String(payload?.status || "");
    if (payload?.error || !status) {
      return { verdict: "indeterminado", reason: "consulta_inconclusiva", pending_intents: pendingIntents };
    }
    pendingIntents.push({ payment_id: p.id, intent_id: intentId, provider: "stripe", status });
    if (status === "succeeded") {
      return { verdict: "pago", reason: "provedor_succeeded", paid_payment_id: p.id, pending_intents: pendingIntents };
    }
    if (status === "processing") {
      return { verdict: "processando", reason: "provedor_processing", pending_intents: pendingIntents };
    }
    if (status !== "canceled") {
      // requires_payment_method / requires_action / requires_confirmation:
      // o intent AINDA pode ser pago.
      verdict = "ativo_no_provedor";
      reason = `provedor_${status}`;
    }
  }

  return { verdict, reason, pending_intents: pendingIntents };
}

// Pago, processando ou indeterminado: NUNCA expira o pedido nem devolve estoque.
// Aceita o veredito direto ou o objeto completo da decisão.
export function isPaymentProtected(guard: PaymentGuard | PaymentGuardVerdict): boolean {
  const verdict = typeof guard === "string" ? guard : guard?.verdict;
  return verdict === "pago" || verdict === "processando" || verdict === "indeterminado";
}

// RECONCILIAÇÃO de reservas órfãs — roda na varredura de manutenção.
//
// Regra (deliberadamente restritiva): só libera o que é comprovadamente órfão.
//   1. Reserva ainda dentro da validade → mantida.
//   2. Pagamento pago/processando/indeterminado (decisão compartilhada com o
//      expirador) → NUNCA libera. Encerra apenas o que já virou venda.
//   3. Intent ainda pagável no provedor → mantida (o expirador cancela e a
//      próxima execução converge).
//   4. Pedido 'pending' ainda dentro da janela de pagamento → mantida.
//   5. Nenhum pedido (tentativa morreu antes do create) ou pedido pendente
//      vencido/cancelado sem pagamento vivo → libera POR TOKEN (uma vez).
// Nunca libera por idade sem essas verificações.
export async function reconcileStockReservations(
  svc: any,
  limit = 25,
  options: { retrieveIntent?: (intentId: string) => Promise<any> } = {},
): Promise<{ examined: number; released: number; kept: number; failed: number; pending: number }> {
  let records: any[] = [];
  try {
    records = await svc.entities[ENTITY].filter(
      { state: { $in: ["claiming", "active"] }, is_deleted: false },
      "created_date",
      Math.max(1, Math.min(Number(limit) || 25, 100)),
    );
  } catch (err: any) {
    console.error("[stockReservation] varredura de reservas falhou:", err?.message || err);
    return { examined: 0, released: 0, kept: 0, failed: 0, pending: 0 };
  }

  const nowMs = Date.now();
  let examined = 0, released = 0, kept = 0, failed = 0, pending = 0;

  // Pagamento vivo: nunca devolve estoque; encerra só o que já foi convertido.
  const settlePaidReservation = async (record: any, orderId: string) => {
    await resumeOrderStockConversion(svc, orderId);
    return consumeReservationIfFullyConverted(svc, record, orderId);
  };

  for (const rec of records || []) {
    examined++;
    try {
      const expiresMs = rec.expires_at
        ? new Date(rec.expires_at).getTime()
        : (rec.created_date ? new Date(rec.created_date).getTime() + STOCK_RESERVATION_TTL_MS : 0);
      if (!expiresMs || expiresMs > nowMs) { kept++; continue; } // dentro da validade

      // Associação: pedido do registro ou o pedido que carrega o mesmo token.
      let order: any = null;
      if (rec.order_id) {
        order = (await svc.entities.Order.filter({ id: rec.order_id }))[0] || null;
      }
      if (!order) {
        order = (await svc.entities.Order.filter({ checkout_token: rec.checkout_token }))[0] || null;
      }
      const orderId = order?.id || rec.order_id || "";

      if (order) {
        // F4-02 (P1) — a MESMA decisão do expirador de pedidos.
        const guard = await assessOrderPaymentState(svc, order, options);
        if (isPaymentProtected(guard.verdict)) {
          if (guard.verdict === "pago") {
            // Dinheiro comprovado: retoma a conversão e encerra só o que virou
            // venda (o que falta fica PENDENTE e vivo — nunca é devolvido).
            const settlement = await settlePaidReservation(rec, orderId);
            kept++;
            if (!settlement.consumed) pending++;
          } else {
            // processando / indeterminado: NADA é decidido nesta execução — nem
            // liberação, nem conversão, nem encerramento. A próxima rodada
            // reavalia o estado no provedor.
            kept++;
          }
          continue;
        }
        // Intent ainda pagável no provedor: devolver aqui seria oversell (o
        // comprador pode concluir o pagamento). O expirador cancela primeiro.
        if (guard.verdict === "ativo_no_provedor") { kept++; continue; }

        // Re-checagem LOCAL imediatamente antes de liberar: um webhook
        // concorrente pode ter confirmado o pagamento entre a consulta e a
        // decisão. Sem prova de ausência de pagamento, não há liberação.
        let freshPayments: any[] = [];
        try {
          freshPayments = (await svc.entities.Payment.filter({ order_id: order.id, is_deleted: false })) || [];
        } catch { kept++; continue; }
        if (freshPayments.some(isLiveLocalPayment)) { kept++; continue; }

        const untilMs = order.reserved_until ? new Date(order.reserved_until).getTime() : 0;
        if (order.status === "pending" && untilMs > nowMs) { kept++; continue; }
        if (order.status === "paid" || order.status === "refunded" || order.status === "partially_refunded") {
          // Pedido já efetivado/estornado: o estoque não está reservado.
          const settlement = await settlePaidReservation(rec, orderId);
          kept++;
          if (!settlement.consumed) pending++;
          continue;
        }
      }

      const out = await releaseReservation(
        svc,
        { ...rec, order_id: orderId },
        order ? "reconcile_order_ended" : "reconcile_orphan",
      );
      await auditRelease(svc, { ...rec, order_id: orderId }, order ? "reconcile_order_ended" : "reconcile_orphan", out.released);
      if (out.released) released++; else failed++;
    } catch (err: any) {
      console.error("[stockReservation] reconciliação de reserva falhou:", rec?.id, err?.message || err);
      failed++;
    }
  }

  return { examined, released, kept, failed, pending };
}