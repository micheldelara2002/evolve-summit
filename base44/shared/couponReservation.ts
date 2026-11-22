// P2-01 (2026-11-22) — CICLO DE VIDA EXPLÍCITO DA RESERVA DE CUPOM.
//
// DEFEITO CORRIGIDO: em `createPaymentIntent` o uso do cupom era reservado
// (`Coupon.uses_count += 1` por CAS) ANTES de o Order existir. Se a criação do
// pedido falhasse depois disso — erro de escrita, corrida de checkout, falha
// entre etapas — o incremento ficava ÓRFÃO: nenhum pedido apontava para ele e
// nenhum caminho sabia que aquela unidade de uso precisava voltar. O cupom
// esgotava sozinho, com o limite consumido por compras que nunca existiram.
//
// DESENHO (a plataforma não tem transação entre documentos):
//
//   CouponReservation  (registro durável, identificável e recuperável)
//        state: reserved → committed   (venda confirmada; uso permanece)
//        state: reserved → released    (devolvido; uso volta ao cupom)
//
//   1. A reserva nasce com token da TENTATIVA de checkout (gerado no servidor),
//      usuário, evento, cupom e validade — antes de qualquer escrita no cupom.
//   2. O incremento em `Coupon.uses_count` acontece só depois, por CAS
//      (`uses_count < max_uses`), e é registrado na própria reserva
//      (`counter_reserved: true`).
//   3. A LIBERAÇÃO é um CAS NA RESERVA (`state: "reserved"` → `"released"`):
//      exatamente uma execução vence e só ela devolve o uso. Repetir é no-op;
//      uma requisição nunca libera a reserva de outra (o id vem da própria
//      tentativa), e o decremento tem guarda `uses_count > 0`.
//   4. Reserva de pagamento ainda em processamento NÃO é liberada: a decisão usa
//      `assessOrderPaymentState` (a MESMA do estoque), que consulta o provedor.
//   5. Falha de leitura nunca libera (fail-closed) — a reserva fica para a
//      próxima varredura.
//   6. Reconciliação classifica cada caso: sem pedido, pedido sem reserva
//      (legado, diagnosticado), pagamento em processamento, confirmado, falhado
//      e reserva expirada.

import { assessOrderPaymentState, isPaymentProtected } from "./stockReservation.ts";

const ENTITY = "CouponReservation";
export const COUPON_RESERVATION_TTL_MS = 15 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

export type CouponReservationResult =
  | { ok: true; reservation: any | null; limited: boolean }
  | { ok: false; reason: string; error: string };

/**
 * Cria a reserva DURÁVEL e só então consome o uso do cupom (CAS).
 * Idempotente por `checkout_token`: repetir a mesma tentativa devolve a reserva.
 */
export async function reserveCouponUsage(
  svc: any,
  params: {
    coupon: any;
    eventId: string;
    userId?: string;
    checkoutToken: string;
    discount?: number;
    ttlMs?: number;
  },
): Promise<CouponReservationResult> {
  const coupon = params?.coupon;
  const checkoutToken = String(params?.checkoutToken || "");
  const eventId = String(params?.eventId || "");
  if (!coupon?.id) return { ok: true, reservation: null, limited: false };
  if (!checkoutToken || !eventId) {
    return { ok: false, reason: "identidade_ausente", error: "Reserva de cupom sem identificação da tentativa." };
  }

  // Idempotência: a MESMA tentativa não cria duas reservas.
  try {
    const existing = await svc.entities[ENTITY].filter({ checkout_token: checkoutToken, is_deleted: false });
    if (Array.isArray(existing) && existing.length > 0) {
      const live = existing.find((r: any) => r.state !== "released") || existing[0];
      const limitedNow = Number(coupon.max_uses) > 0;
      // P2-01 (residual) — CURA DO CONSUMO: se a tentativa anterior caiu entre
      // criar a reserva e consumir o uso, o ledger do cupom ainda não a contém.
      // Repetir o checkout reconhece a reserva (idempotente) e aqui CONCLUI o
      // consumo que faltou — sem isso o cupom ficaria sobre-utilizável para
      // sempre, porque nenhum caminho voltaria a incrementar por esta reserva.
      if (limitedNow && live.state === "reserved") {
        const ensured = await ensureCouponUseConsumed(svc, live, coupon);
        if (!ensured.ok) {
          return { ok: false, reason: ensured.reason, error: "Não foi possível confirmar o uso do cupom agora." };
        }
        if (ensured.exhausted) {
          return { ok: false, reason: "coupon_exhausted", error: "Cupom esgotado — o limite de utilizações foi atingido." };
        }
      }
      return { ok: true, reservation: live, limited: limitedNow };
    }
  } catch (err: any) {
    // Sem conseguir verificar, não reserva: falha fechada.
    console.error("[couponReservation] consulta da reserva falhou:", err?.message || err);
    return { ok: false, reason: "reservation_lookup_unavailable", error: "Não foi possível reservar o cupom agora." };
  }

  const limited = Number(coupon.max_uses) > 0;
  const ttl = Number(params?.ttlMs) || COUPON_RESERVATION_TTL_MS;
  let reservation: any = null;
  try {
    reservation = await svc.entities[ENTITY].create({
      event_id: eventId,
      coupon_id: coupon.id,
      coupon_code: String(coupon.code || ""),
      user_id: String(params?.userId || ""),
      order_id: "",
      checkout_token: checkoutToken,
      correlation_id: checkoutToken,
      state: "reserved",
      discount: Number(params?.discount) || 0,
      reserved_at: nowIso(),
      expires_at: new Date(Date.now() + ttl).toISOString(),
      counter_reserved: false,
      counter_decremented: false,
      counter_state: limited ? "pending" : "not_applicable",
      is_deleted: false,
    });
  } catch (err: any) {
    console.error("[couponReservation] reserva não gravada:", err?.message || err);
    return { ok: false, reason: "reservation_unavailable", error: "Não foi possível reservar o cupom agora." };
  }
  if (!reservation?.id) {
    return { ok: false, reason: "reservation_unconfirmed", error: "A reserva do cupom não confirmou a gravação." };
  }

  if (!limited) {
    // Cupom ilimitado não consome teto (o uso é contabilizado no fulfillment).
    return { ok: true, reservation, limited: false };
  }

  const ensured = await ensureCouponUseConsumed(svc, reservation, coupon);
  if (!ensured.ok) {
    return { ok: false, reason: ensured.reason, error: "Não foi possível confirmar o uso do cupom agora." };
  }

  if (ensured.exhausted) {
    // Teto esgotado em corrida: encerra a reserva desta tentativa SEM decrementar
    // (nada foi consumido) — `counter_reserved: false` e `counter_state:
    // 'not_consumed'` na MESMA escrita, para que a reconciliação não devolva um
    // uso que esta reserva nunca consumiu.
    try {
      await svc.entities[ENTITY].updateMany(
        { id: reservation.id, state: "reserved" },
        {
          $set: {
            state: "released",
            released_reason: "coupon_exhausted",
            released_at: nowIso(),
            counter_reserved: false,
            counter_state: "not_consumed",
          },
        },
      );
    } catch { /* a reserva fica visível para a reconciliação */ }
    return { ok: false, reason: "coupon_exhausted", error: "Cupom esgotado — o limite de utilizações foi atingido." };
  }

  return { ok: true, reservation: { ...reservation, counter_reserved: true, counter_state: "reserved" }, limited: true };
}

/**
 * P2-01 (residual) — CONSUMO IDEMPOTENTE DO USO, provado pelo LEDGER DO CUPOM.
 *
 * O incremento e o registro de QUEM incrementou acontecem na MESMA escrita
 * (`$inc +1` + `$addToSet reserved_reservation_ids`, com guarda `$ne`): não
 * existe estado em que `uses_count` subiu sem o cupom saber por qual reserva.
 * Isso é o que permite recuperar as duas falhas possíveis:
 *   • crash DEPOIS do incremento: o ledger já contém a reserva e a repetição é
 *     no-op (`$ne` não casa) — nunca há segundo incremento;
 *   • crash ANTES do incremento: o ledger não a contém e a repetição conclui o
 *     consumo — nunca há uso não contabilizado.
 * Nenhuma decisão depende do campo de diagnóstico `counter_reserved`.
 */
async function ensureCouponUseConsumed(
  svc: any,
  reservation: any,
  coupon: any,
): Promise<{ ok: boolean; consumed: boolean; exhausted?: boolean; reason: string }> {
  const reservationId = String(reservation?.id || "");
  const couponId = String(coupon?.id || reservation?.coupon_id || "");
  const maxUses = Number(coupon?.max_uses) || 0;
  if (!reservationId || !couponId) return { ok: false, consumed: false, reason: "identidade_ausente" };
  if (!(maxUses > 0)) return { ok: true, consumed: false, reason: "ilimitado" };

  let current: any = null;
  try {
    current = (await svc.entities.Coupon.filter({ id: couponId }))[0] || null;
  } catch (err: any) {
    console.error("[couponReservation] leitura do ledger do cupom falhou:", err?.message || err);
    return { ok: false, consumed: false, reason: "coupon_lookup_unavailable" };
  }
  if (!current) return { ok: false, consumed: false, reason: "coupon_missing" };
  const reservedLedger = Array.isArray(current.reserved_reservation_ids) ? current.reserved_reservation_ids : [];
  if (reservedLedger.includes(reservationId)) return { ok: true, consumed: true, reason: "ja_consumido" };

  let updated = 0;
  try {
    const res = await svc.entities.Coupon.updateMany(
      { id: couponId, reserved_reservation_ids: { $ne: reservationId }, uses_count: { $lt: maxUses } },
      { $inc: { uses_count: 1 }, $addToSet: { reserved_reservation_ids: reservationId } },
    );
    updated = res && res.updated ? res.updated : 0;
  } catch (err: any) {
    console.error("[couponReservation] consumo do uso falhou:", err?.message || err);
    return { ok: false, consumed: false, reason: "coupon_consume_unavailable" };
  }

  if (updated) {
    try {
      await svc.entities[ENTITY].updateMany(
        { id: reservationId },
        { $set: { counter_reserved: true, counter_state: "reserved" } },
      );
    } catch { /* diagnóstico: o ledger já prova o consumo */ }
    return { ok: true, consumed: true, reason: "consumido" };
  }

  // Zero atualização não prova nada: pode ser corrida (outra execução consumiu
  // por esta mesma reserva) ou teto esgotado. A leitura decide.
  let after: any = null;
  try {
    after = (await svc.entities.Coupon.filter({ id: couponId }))[0] || null;
  } catch (err: any) {
    return { ok: false, consumed: false, reason: "coupon_confirm_unavailable" };
  }
  if (!after) return { ok: false, consumed: false, reason: "coupon_missing" };
  const afterLedger = Array.isArray(after.reserved_reservation_ids) ? after.reserved_reservation_ids : [];
  if (afterLedger.includes(reservationId)) return { ok: true, consumed: true, reason: "ja_consumido" };
  if ((Number(after.uses_count) || 0) >= maxUses) return { ok: true, consumed: false, exhausted: true, reason: "esgotado" };
  return { ok: false, consumed: false, reason: "coupon_consume_unconfirmed" };
}

/** Liga a reserva ao pedido criado/reutilizado (idempotente). */
export async function attachCouponReservation(svc: any, reservationId: string, orderId: string): Promise<boolean> {
  if (!reservationId || !orderId) return false;
  try {
    const res = await svc.entities[ENTITY].updateMany(
      { id: reservationId, order_id: "" },
      { $set: { order_id: orderId } },
    );
    return !!(res && res.updated);
  } catch (err: any) {
    console.error("[couponReservation] associação ao pedido falhou:", err?.message || err);
    return false;
  }
}

/**
 * Libera a reserva — EXATAMENTE UMA VEZ (CAS reserved → released) — e devolve o
 * uso ao cupom quando o contador ainda não foi tratado por outro caminho.
 *
 * `counterHandledBy: "order"` é usado quando o decremento já é responsabilidade
 * do marcador do pedido (releaseCouponUse / estorno integral): a reserva apenas
 * registra o desfecho, sem tocar `uses_count` de novo.
 */
export async function releaseCouponReservation(
  svc: any,
  reservationId: string,
  reason: string,
  opts: { counterHandledBy?: "order" | "reservation"; allowCommitted?: boolean } = {},
): Promise<{ released: boolean; decremented: boolean; counterState: string; reason: string }> {
  if (!reservationId) return { released: false, decremented: false, counterState: "unknown", reason: "sem_reserva" };

  let row: any = null;
  try {
    row = (await svc.entities[ENTITY].filter({ id: reservationId }))[0] || null;
  } catch (err: any) {
    return { released: false, decremented: false, counterState: "unknown", reason: `leitura_indisponivel:${err?.message || err}` };
  }
  if (!row) return { released: false, decremented: false, counterState: "unknown", reason: "nao_encontrada" };
  // `allowCommitted`: o estorno integral reverte uma venda já confirmada —
  // a reserva deixa de representar uso consumido e passa a 'released'.
  const fromStates = opts.allowCommitted ? ["reserved", "committed"] : ["reserved"];
  if (!fromStates.includes(String(row.state))) {
    return { released: false, decremented: false, counterState: String(row.counter_state || "unknown"), reason: `estado_${row.state}` };
  }

  // P2-01 (residual) — O ESTADO DA COMPENSAÇÃO ENTRA NA MESMA ESCRITA DA
  // LIBERAÇÃO. Antes, o CAS só marcava `released` e o decremento vinha depois,
  // fora de qualquer registro: um crash nessa janela deixava a reserva liberada,
  // o contador alto e `counter_decremented: false` — e a reconciliação, que só
  // olhava `state = reserved`, nunca voltava nesse caso (vazamento permanente).
  // Agora a liberação já declara o que falta fazer:
  //   handled_by_order → a devolução é do marcador do pedido (nada a compensar);
  //   pending          → esta reserva consumiu um uso e a devolução está PENDENTE;
  //   not_consumed     → nada foi consumido (nenhum decremento é devido).
  const counterState = opts.counterHandledBy === "order"
    ? "handled_by_order"
    : (row.counter_reserved === true ? "pending" : "not_consumed");
  const releasePatch: Record<string, any> = {
    state: "released",
    released_reason: reason,
    released_at: nowIso(),
    counter_state: counterState,
  };
  if (opts.counterHandledBy === "order") releasePatch.counter_handled_by = "order";

  let claimed = false;
  try {
    const res = await svc.entities[ENTITY].updateMany(
      { id: reservationId, state: { $in: fromStates } },
      { $set: releasePatch },
    );
    claimed = !!(res && res.updated);
  } catch (err: any) {
    return { released: false, decremented: false, counterState: "unknown", reason: `liberacao_indisponivel:${err?.message || err}` };
  }
  if (!claimed) return { released: false, decremented: false, counterState: "unknown", reason: "corrida" };

  if (counterState !== "pending") {
    return { released: true, decremented: false, counterState, reason };
  }

  // Compensação: exatamente-uma-vez pelo ledger do cupom. Se ela falhar agora,
  // a reserva fica com `counter_state: "pending"` e a reconciliação conclui —
  // a repetição é no-op porque o ledger já registra a devolução.
  const compensation = await compensateCouponReservation(svc, reservationId);
  return { released: true, decremented: compensation.compensated, counterState: compensation.state, reason };
}

/**
 * P2-01 (residual) — COMPENSAÇÃO DO CONTADOR, RECUPERÁVEL E EXATAMENTE-UMA-VEZ.
 *
 * A autoridade não é o campo de diagnóstico da reserva: é o LEDGER do cupom.
 * O decremento é uma única escrita condicional no próprio Coupon:
 *
 *   { id, released_reservation_ids: { $ne: reservationId },
 *     reserved_reservation_ids: reservationId, uses_count: { $gt: 0 } }
 *   → $inc uses_count -1  + $addToSet released_reservation_ids
 *                          + $pull reserved_reservation_ids
 *
 * Consequências (nenhuma delas depende de estado intermediário ou de memória da
 * execução anterior):
 *   • repetir é no-op — a segunda execução não casa `$ne` e não decrementa;
 *   • dois reconciliadores concorrentes: apenas um casa a condição;
 *   • crash antes do decremento → a reserva continua `pending` e a varredura
 *     seguinte conclui;
 *   • crash depois do decremento → o ledger já registra a devolução; a varredura
 *     apenas marca a reserva como concluída (sem segundo decremento);
 *   • cupom ausente/ilegível ou ledger incapaz de provar o desfecho → a reserva
 *     vai para `manual_review` e NADA é decrementado por suposição.
 */
export async function compensateCouponReservation(
  svc: any,
  reservationId: string,
): Promise<{ ok: boolean; compensated: boolean; state: string; reason: string }> {
  if (!reservationId) return { ok: false, compensated: false, state: "unknown", reason: "sem_reserva" };

  let row: any = null;
  try {
    row = (await svc.entities[ENTITY].filter({ id: reservationId }))[0] || null;
  } catch (err: any) {
    return { ok: false, compensated: false, state: "pending", reason: `leitura_indisponivel:${err?.message || err}` };
  }
  if (!row) return { ok: false, compensated: false, state: "unknown", reason: "nao_encontrada" };
  if (row.counter_handled_by === "order" || row.counter_state === "handled_by_order") {
    return { ok: true, compensated: false, state: "handled_by_order", reason: "delegado_ao_pedido" };
  }
  if (row.counter_decremented === true || row.counter_state === "completed") {
    return { ok: true, compensated: false, state: "completed", reason: "ja_compensada" };
  }
  if (row.counter_state === "not_consumed") {
    return { ok: true, compensated: false, state: "not_consumed", reason: "nada_consumido" };
  }

  const couponId = String(row.coupon_id || "");
  let coupon: any = null;
  try {
    coupon = (await svc.entities.Coupon.filter({ id: couponId }))[0] || null;
  } catch (err: any) {
    // Indisponibilidade NÃO é divergência: a reserva segue `pending` e a próxima
    // varredura tenta de novo.
    return { ok: false, compensated: false, state: "pending", reason: `cupom_indisponivel:${err?.message || err}` };
  }
  if (!coupon) {
    await markCompensation(svc, reservationId, "manual_review", false, "Cupom não encontrado — devolução não comprovável.");
    return { ok: false, compensated: false, state: "manual_review", reason: "cupom_ausente" };
  }

  const releasedLedger = Array.isArray(coupon.released_reservation_ids) ? coupon.released_reservation_ids : [];
  if (releasedLedger.includes(reservationId)) {
    await markCompensation(svc, reservationId, "completed", true, "");
    return { ok: true, compensated: false, state: "completed", reason: "ja_compensada" };
  }
  const reservedLedger = Array.isArray(coupon.reserved_reservation_ids) ? coupon.reserved_reservation_ids : null;
  if (!reservedLedger) {
    // Cupom anterior ao ledger (legado): não há como provar se ESTA reserva
    // incrementou o contador. Decrementar seria adivinhar — vai para revisão.
    await markCompensation(svc, reservationId, "manual_review", false, "Cupom sem ledger de reservas — desfecho do contador não comprovável.");
    return { ok: false, compensated: false, state: "manual_review", reason: "ledger_ausente" };
  }
  if (!reservedLedger.includes(reservationId)) {
    // Nada foi consumido por esta reserva: nenhum decremento é devido.
    await markCompensation(svc, reservationId, "not_consumed", false, "");
    return { ok: true, compensated: false, state: "not_consumed", reason: "nada_consumido" };
  }

  let updated = 0;
  try {
    const res = await svc.entities.Coupon.updateMany(
      {
        id: couponId,
        released_reservation_ids: { $ne: reservationId },
        reserved_reservation_ids: reservationId,
        uses_count: { $gt: 0 },
      },
      {
        $inc: { uses_count: -1 },
        $addToSet: { released_reservation_ids: reservationId },
        $pull: { reserved_reservation_ids: reservationId },
      },
    );
    updated = res && res.updated ? res.updated : 0;
  } catch (err: any) {
    console.error("[couponReservation] compensação do contador falhou:", reservationId, err?.message || err);
    return { ok: false, compensated: false, state: "pending", reason: `compensacao_indisponivel:${err?.message || err}` };
  }

  if (updated) {
    await markCompensation(svc, reservationId, "completed", true, "");
    return { ok: true, compensated: true, state: "completed", reason: "compensada" };
  }

  // Zero atualização: pode ser repetição (já devolvido), corrida perdida ou
  // divergência de saldo. A leitura decide — nunca a resposta do update.
  let after: any = null;
  try {
    after = (await svc.entities.Coupon.filter({ id: couponId }))[0] || null;
  } catch (err: any) {
    return { ok: false, compensated: false, state: "pending", reason: `confirmacao_indisponivel:${err?.message || err}` };
  }
  const afterReleased = Array.isArray(after?.released_reservation_ids) ? after.released_reservation_ids : [];
  if (afterReleased.includes(reservationId)) {
    await markCompensation(svc, reservationId, "completed", true, "");
    return { ok: true, compensated: false, state: "completed", reason: "ja_compensada" };
  }
  const afterReserved = Array.isArray(after?.reserved_reservation_ids) ? after.reserved_reservation_ids : [];
  if (after && afterReserved.includes(reservationId)) {
    // O cupom reconhece o consumo mas não devolve (saldo zerado): divergência.
    await markCompensation(svc, reservationId, "manual_review", false, "Contador do cupom zerado com consumo registrado — revisar manualmente.");
    return { ok: false, compensated: false, state: "manual_review", reason: "contador_divergente" };
  }
  await markCompensation(svc, reservationId, "not_consumed", false, "");
  return { ok: true, compensated: false, state: "not_consumed", reason: "nada_consumido" };
}

// Marcador de diagnóstico da compensação. A garantia está no ledger do cupom;
// falhar aqui não perde nem duplica devolução — a próxima leitura re-deriva.
async function markCompensation(
  svc: any,
  reservationId: string,
  state: string,
  decremented: boolean,
  reviewReason: string,
): Promise<void> {
  try {
    await svc.entities[ENTITY].updateMany(
      { id: reservationId },
      {
        $set: {
          counter_state: state,
          counter_decremented: decremented,
          counter_handled_by: state === "handled_by_order" ? "order" : "reservation",
          counter_review_reason: reviewReason,
        },
      },
    );
  } catch { /* diagnóstico: o ledger é a autoridade */ }
}

/** Encerra a reserva como venda confirmada (uso permanece consumido). */
export async function commitCouponReservation(
  svc: any,
  reservationId: string,
  reason = "pagamento_confirmado",
): Promise<boolean> {
  if (!reservationId) return false;
  try {
    const res = await svc.entities[ENTITY].updateMany(
      { id: reservationId, state: "reserved" },
      { $set: { state: "committed", committed_at: nowIso(), commit_reason: reason } },
    );
    return !!(res && res.updated);
  } catch (err: any) {
    console.error("[couponReservation] confirmação falhou:", err?.message || err);
    return false;
  }
}

/**
 * Libera as reservas ligadas a um pedido (expiração/cancelamento). Quando o
 * decremento do uso já é feito pelo marcador do pedido, passa `counterHandledBy`.
 */
export async function releaseCouponReservationsForOrder(
  svc: any,
  order: any,
  reason: string,
  opts: { counterHandledBy?: "order" | "reservation"; allowCommitted?: boolean } = {},
): Promise<{ released: number; decremented: number; examined: number }> {
  const orderId = String(order?.id || "");
  if (!orderId) return { released: 0, decremented: 0, examined: 0 };

  const states = opts.allowCommitted ? ["reserved", "committed"] : ["reserved"];
  let rows: any[] = [];
  try {
    rows = await svc.entities[ENTITY].filter({ order_id: orderId, state: { $in: states }, is_deleted: false });
  } catch (err: any) {
    console.error("[couponReservation] consulta por pedido falhou:", err?.message || err);
    return { released: 0, decremented: 0, examined: 0 };
  }
  if (!Array.isArray(rows)) return { released: 0, decremented: 0, examined: 0 };

  let released = 0;
  let decremented = 0;
  for (const row of rows) {
    const out = await releaseCouponReservation(svc, row.id, reason, opts);
    if (out.released) released++;
    if (out.decremented) decremented++;
  }
  return { released, decremented, examined: rows.length };
}

/** Confirma as reservas do pedido quando o pagamento foi confirmado. */
export async function commitCouponReservationsForOrder(
  svc: any,
  orderId: string,
  reason = "pagamento_confirmado",
): Promise<{ committed: number; examined: number }> {
  if (!orderId) return { committed: 0, examined: 0 };
  let rows: any[] = [];
  try {
    rows = await svc.entities[ENTITY].filter({ order_id: orderId, state: "reserved", is_deleted: false });
  } catch (err: any) {
    console.error("[couponReservation] consulta para confirmação falhou:", err?.message || err);
    return { committed: 0, examined: 0 };
  }
  if (!Array.isArray(rows)) return { committed: 0, examined: 0 };
  let committed = 0;
  for (const row of rows) {
    if (await commitCouponReservation(svc, row.id, reason)) committed++;
  }
  return { committed, examined: rows.length };
}

// ===== RECONCILIAÇÃO =====
//
// Cada reserva é classificada em UMA categoria e recebe a ação correspondente:
//   sem_pedido          → libera quando vencida (nada foi comprado);
//   pagamento_confirmado→ confirma (venda existe, uso permanece);
//   processando         → mantém (dinheiro em trânsito; nada é devolvido);
//   indeterminado       → mantém (provedor indisponível: fail-closed);
//   ativo_no_provedor   → mantém (o comprador ainda pode pagar);
//   pedido_encerrado    → libera com `counterHandledBy: "order"` (o expirador já
//                         devolveu o uso pelo marcador do pedido);
//   pedido_vivo         → mantém (dentro da janela de pagamento);
//   leitura_indisponivel→ mantém e conta como indisponível.
export async function reconcileCouponReservations(
  svc: any,
  limit = 50,
  options: { retrieveIntent?: (intentId: string) => Promise<any>; nowMs?: number } = {},
): Promise<{
  examined: number;
  released: number;
  committed: number;
  kept: number;
  unavailable: number;
  categories: Record<string, number>;
  // P2-01 (residual) — varredura de COMPENSAÇÃO do contador.
  compensationExamined: number;
  compensated: number;
  compensationPending: number;
  manualReview: number;
}> {
  const categories: Record<string, number> = {
    sem_pedido: 0,
    pagamento_confirmado: 0,
    processando: 0,
    indeterminado: 0,
    ativo_no_provedor: 0,
    pedido_encerrado: 0,
    pedido_vivo: 0,
    leitura_indisponivel: 0,
  };
  const result = {
    examined: 0,
    released: 0,
    committed: 0,
    kept: 0,
    unavailable: 0,
    categories,
    compensationExamined: 0,
    compensated: 0,
    compensationPending: 0,
    manualReview: 0,
  };

  let rows: any[] = [];
  try {
    rows = await svc.entities[ENTITY].filter(
      { state: "reserved", is_deleted: false },
      "created_date",
      Math.max(1, Math.min(Number(limit) || 50, 200)),
    );
  } catch (err: any) {
    console.error("[couponReservation] varredura falhou:", err?.message || err);
    result.unavailable++;
    categories.leitura_indisponivel++;
    return result;
  }
  if (!Array.isArray(rows)) {
    result.unavailable++;
    categories.leitura_indisponivel++;
    return result;
  }

  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();

  for (const row of rows) {
    result.examined++;
    try {
      const expiresMs = row.expires_at
        ? new Date(row.expires_at).getTime()
        : (row.created_date ? new Date(row.created_date).getTime() + COUPON_RESERVATION_TTL_MS : 0);

      let order: any = null;
      if (row.order_id) {
        try {
          order = (await svc.entities.Order.filter({ id: row.order_id }))[0] || null;
        } catch (err: any) {
          console.error("[couponReservation] leitura do pedido falhou:", err?.message || err);
          result.unavailable++;
          categories.leitura_indisponivel++;
          continue;
        }
      }

      if (!order && row.checkout_token) {
        // P2-01 (residual) — o vínculo pode não ter sido gravado (crash entre o
        // create do Order e o attach): procurar pelo token da tentativa antes de
        // declarar a reserva órfã. Sem isso, uma compra viva com pagamento em
        // andamento poderia ser liberada como se nenhum pedido existisse.
        try {
          order = (await svc.entities.Order.filter({ checkout_token: row.checkout_token }))[0] || null;
        } catch (err: any) {
          console.error("[couponReservation] leitura do pedido por token falhou:", err?.message || err);
          result.unavailable++;
          categories.leitura_indisponivel++;
          continue;
        }
      }

      if (!order) {
        categories.sem_pedido++;
        if (expiresMs && expiresMs <= nowMs) {
          const out = await releaseCouponReservation(svc, row.id, "reconcile_orphan");
          if (out.released) result.released++;
          else result.kept++;
        } else {
          result.kept++;
        }
        continue;
      }

      const guard = await assessOrderPaymentState(svc, order, options);
      if (isPaymentProtected(guard.verdict)) {
        if (guard.verdict === "pago") {
          categories.pagamento_confirmado++;
          if (await commitCouponReservation(svc, row.id, "reconcile_paid")) result.committed++;
          else result.kept++;
        } else {
          categories[guard.verdict === "processando" ? "processando" : "indeterminado"]++;
          result.kept++;
        }
        continue;
      }

      if (guard.verdict === "ativo_no_provedor") {
        categories.ativo_no_provedor++;
        result.kept++;
        continue;
      }

      if (order.status === "cancelled" || order.status === "refunded" || order.status === "partially_refunded") {
        categories.pedido_encerrado++;
        // O uso já foi devolvido pelo marcador do pedido (releaseCouponUse).
        const out = await releaseCouponReservation(svc, row.id, "reconcile_order_ended", {
          counterHandledBy: "order",
        });
        if (out.released) result.released++;
        else result.kept++;
        continue;
      }

      const untilMs = order.reserved_until ? new Date(order.reserved_until).getTime() : 0;
      if (order.status === "pending" && untilMs > nowMs) {
        categories.pedido_vivo++;
        result.kept++;
        continue;
      }

      // Pedido pendente vencido e sem pagamento vivo: o expirador encerra o
      // pedido e devolve o uso pelo marcador. Aqui só se libera quando o pedido
      // já não está mais pendente — nunca se antecipa o expirador.
      categories.pedido_vivo++;
      result.kept++;
    } catch (err: any) {
      console.error("[couponReservation] reconciliação da reserva falhou:", row?.id, err?.message || err);
      result.unavailable++;
      categories.leitura_indisponivel++;
    }
  }

  // P2-01 (residual) — SEGUNDA VARREDURA: COMPENSAÇÃO PENDENTE.
  // Independe do estado `reserved`: olha reservas JÁ LIBERADAS cuja devolução do
  // uso ainda não foi confirmada. É exatamente a janela que antes vazava para
  // sempre (crash entre `released` e o decremento).
  try {
    const compensation = await reconcileCouponCounterCompensation(svc, limit);
    result.compensationExamined = compensation.examined;
    result.compensated = compensation.compensated;
    result.compensationPending = compensation.pending;
    result.manualReview = compensation.manualReview;
    if (compensation.unavailable > 0) result.unavailable++;
  } catch (err: any) {
    console.error("[couponReservation] varredura de compensação falhou:", err?.message || err);
    result.unavailable++;
  }

  return result;
}

/**
 * P2-01 (residual) — VARREDURA DE COMPENSAÇÃO DO CONTADOR.
 *
 * Reprocessa reservas LIBERADAS com devolução não confirmada, em qualquer ponto
 * em que a execução anterior tenha caído (antes/depois do decremento, antes da
 * marcação). Cada item passa por `compensateCouponReservation`, cujo CAS no
 * ledger do cupom garante exatamente-uma-vez — dois reconciliadores concorrentes
 * ou o mesmo item processado N vezes convergem para o mesmo contador.
 *
 * Uma reserva cujo desfecho não pode ser provado (cupom ausente, ledger legado,
 * saldo divergente) fica em `manual_review` e é CONTADA — nunca decrementada por
 * suposição, nunca escondida.
 */
export async function reconcileCouponCounterCompensation(
  svc: any,
  limit = 50,
): Promise<{ examined: number; compensated: number; pending: number; manualReview: number; unavailable: number }> {
  const out = { examined: 0, compensated: 0, pending: 0, manualReview: 0, unavailable: 0 };
  let rows: any[] = [];
  try {
    rows = await svc.entities[ENTITY].filter(
      {
        is_deleted: false,
        $or: [
          { state: "released", counter_state: "pending" },
          {
            state: "released",
            counter_state: { $exists: false },
            counter_reserved: true,
            counter_decremented: false,
            counter_handled_by: { $exists: false },
          },
        ],
      },
      "created_date",
      Math.max(1, Math.min(Number(limit) || 50, 200)),
    );
  } catch (err: any) {
    console.error("[couponReservation] consulta de compensações pendentes falhou:", err?.message || err);
    out.unavailable++;
    return out;
  }
  if (!Array.isArray(rows)) {
    out.unavailable++;
    return out;
  }

  for (const row of rows) {
    out.examined++;
    const res = await compensateCouponReservation(svc, row.id);
    if (res.compensated) out.compensated++;
    if (res.state === "manual_review") out.manualReview++;
    else if (!res.ok) out.pending++;
  }
  return out;
}

/**
 * Diagnóstico (sem escrita): pedidos com cupom contabilizado e SEM reserva
 * identificada — casos legados anteriores ao ciclo de vida. Não são alterados:
 * o marcador do pedido continua sendo a autoridade do contador para eles.
 */
export async function diagnoseLegacyCouponOrders(
  svc: any,
  limit = 50,
): Promise<{ examined: number; legacy: number; unavailable: boolean }> {
  let orders: any[] = [];
  try {
    orders = await svc.entities.Order.filter(
      { coupon_id: { $exists: true }, coupon_uses_counted: true, is_deleted: false },
      "-created_date",
      Math.max(1, Math.min(Number(limit) || 50, 200)),
    );
  } catch (err: any) {
    console.error("[couponReservation] diagnóstico de pedidos legados falhou:", err?.message || err);
    return { examined: 0, legacy: 0, unavailable: true };
  }
  if (!Array.isArray(orders)) return { examined: 0, legacy: 0, unavailable: true };

  let legacy = 0;
  for (const order of orders) {
    if (!order?.id || !order?.coupon_id) continue;
    try {
      const rows = await svc.entities[ENTITY].filter({ order_id: order.id, is_deleted: false });
      if (Array.isArray(rows) && rows.length === 0) legacy++;
    } catch {
      return { examined: orders.length, legacy, unavailable: true };
    }
  }
  return { examined: orders.length, legacy, unavailable: false };
}