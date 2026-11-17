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

// ENCERRAMENTO por venda confirmada: reserved→sold já aconteceu item a item no
// fulfillment; aqui o token sai do lote (sem decremento — o estoque virou
// vendido) e o registro passa a 'consumed', estado terminal. Nenhuma
// reconciliação pode devolver esse estoque depois.
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

export async function consumeOrderReservations(svc: any, orderId: string): Promise<{ consumed: number }> {
  if (!orderId) return { consumed: 0 };
  let records: any[] = [];
  try {
    records = await svc.entities[ENTITY].filter({
      order_id: orderId,
      state: { $in: ["claiming", "active"] },
      is_deleted: false,
    });
  } catch (err: any) {
    console.error("[stockReservation] consulta de reservas do pedido falhou:", err?.message || err);
    return { consumed: 0 };
  }
  let consumed = 0;
  for (const rec of records || []) {
    if (await consumeReservation(svc, rec)) consumed++;
  }
  return { consumed };
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

// RECONCILIAÇÃO de reservas órfãs — roda na varredura de manutenção.
//
// Regra (deliberadamente restritiva): só libera o que é comprovadamente órfão.
//   1. Reserva ainda dentro da validade → mantida.
//   2. Pagamento confirmado (succeeded / pending_retry / fulfilled) no pedido
//      associado → NUNCA libera: consolida como 'consumed'.
//   3. Pedido 'pending' ainda dentro da janela de pagamento → mantida.
//   4. Nenhum pedido (tentativa morreu antes do create) ou pedido pendente
//      vencido/cancelado sem pagamento vivo → libera POR TOKEN (uma vez).
// Nunca libera por idade sem essas verificações.
export async function reconcileStockReservations(
  svc: any,
  limit = 25,
): Promise<{ examined: number; released: number; kept: number; failed: number }> {
  let records: any[] = [];
  try {
    records = await svc.entities[ENTITY].filter(
      { state: { $in: ["claiming", "active"] }, is_deleted: false },
      "created_date",
      Math.max(1, Math.min(Number(limit) || 25, 100)),
    );
  } catch (err: any) {
    console.error("[stockReservation] varredura de reservas falhou:", err?.message || err);
    return { examined: 0, released: 0, kept: 0, failed: 0 };
  }

  const nowMs = Date.now();
  let examined = 0, released = 0, kept = 0, failed = 0;

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

      if (order) {
        const payments = await svc.entities.Payment.filter({ order_id: order.id, is_deleted: false });
        const livePayment = (payments || []).find((p: any) =>
          p.status === "succeeded" ||
          p.fulfillment_status === "pending_retry" ||
          p.fulfillment_status === "fulfilled"
        );
        if (livePayment) {
          // Dinheiro real: a reserva NUNCA é devolvida. Consolida o registro.
          await consumeReservation(svc, rec);
          kept++;
          continue;
        }
        const untilMs = order.reserved_until ? new Date(order.reserved_until).getTime() : 0;
        if (order.status === "pending" && untilMs > nowMs) { kept++; continue; }
        if (order.status === "paid" || order.status === "refunded" || order.status === "partially_refunded") {
          // Pedido já efetivado/estornado: o estoque não está reservado.
          await consumeReservation(svc, rec);
          kept++;
          continue;
        }
      }

      const out = await releaseReservation(
        svc,
        { ...rec, order_id: rec.order_id || order?.id || "" },
        order ? "reconcile_order_ended" : "reconcile_orphan",
      );
      await auditRelease(svc, { ...rec, order_id: rec.order_id || order?.id || "" }, order ? "reconcile_order_ended" : "reconcile_orphan", out.released);
      if (out.released) released++; else failed++;
    } catch (err: any) {
      console.error("[stockReservation] reconciliação de reserva falhou:", rec?.id, err?.message || err);
      failed++;
    }
  }

  return { examined, released, kept, failed };
}