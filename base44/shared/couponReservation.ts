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
      return { ok: true, reservation: live, limited: Number(coupon.max_uses) > 0 };
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
      counter_reserved: limited,
      counter_decremented: false,
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

  let incremented = false;
  try {
    const res = await svc.entities.Coupon.updateMany(
      { id: coupon.id, uses_count: { $lt: Number(coupon.max_uses) } },
      { $inc: { uses_count: 1 } },
    );
    incremented = !!(res && res.updated);
  } catch (err: any) {
    console.error("[couponReservation] consumo do uso falhou:", err?.message || err);
  }

  if (!incremented) {
    // Lote de uso esgotado em corrida: encerra a reserva desta tentativa sem
    // decrementar (nada foi consumido) e informa o chamador.
    try {
      await svc.entities[ENTITY].updateMany(
        { id: reservation.id, state: "reserved" },
        { $set: { state: "released", released_reason: "coupon_exhausted", released_at: nowIso() } },
      );
    } catch { /* a reserva fica visível para a reconciliação */ }
    return { ok: false, reason: "coupon_exhausted", error: "Cupom esgotado — o limite de utilizações foi atingido." };
  }

  return { ok: true, reservation, limited: true };
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
): Promise<{ released: boolean; decremented: boolean; reason: string }> {
  if (!reservationId) return { released: false, decremented: false, reason: "sem_reserva" };

  let row: any = null;
  try {
    row = (await svc.entities[ENTITY].filter({ id: reservationId }))[0] || null;
  } catch (err: any) {
    return { released: false, decremented: false, reason: `leitura_indisponivel:${err?.message || err}` };
  }
  if (!row) return { released: false, decremented: false, reason: "nao_encontrada" };
  // `allowCommitted`: o estorno integral reverte uma venda já confirmada —
  // a reserva deixa de representar uso consumido e passa a 'released'.
  const fromStates = opts.allowCommitted ? ["reserved", "committed"] : ["reserved"];
  if (!fromStates.includes(String(row.state))) {
    return { released: false, decremented: false, reason: `estado_${row.state}` };
  }

  let claimed = false;
  try {
    const res = await svc.entities[ENTITY].updateMany(
      { id: reservationId, state: { $in: fromStates } },
      { $set: { state: "released", released_reason: reason, released_at: nowIso() } },
    );
    claimed = !!(res && res.updated);
  } catch (err: any) {
    return { released: false, decremented: false, reason: `liberacao_indisponivel:${err?.message || err}` };
  }
  if (!claimed) return { released: false, decremented: false, reason: "corrida" };

  let decremented = false;
  if (row.counter_reserved === true && opts.counterHandledBy !== "order") {
    try {
      const dec = await svc.entities.Coupon.updateMany(
        { id: row.coupon_id, uses_count: { $gt: 0 } },
        { $inc: { uses_count: -1 } },
      );
      decremented = !!(dec && dec.updated);
    } catch (err: any) {
      console.error("[couponReservation] devolução do uso falhou:", err?.message || err);
    }
    try {
      await svc.entities[ENTITY].updateMany(
        { id: reservationId },
        { $set: { counter_decremented: decremented } },
      );
    } catch { /* registro de diagnóstico */ }
  }

  return { released: true, decremented, reason };
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
  const result = { examined: 0, released: 0, committed: 0, kept: 0, unavailable: 0, categories };

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

  return result;
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