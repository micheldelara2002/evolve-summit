// P1.1/P1.2 (patch Fase 1) — LEDGER FINANCEIRO DO ESTORNO.
//
// Separação conceitual que este módulo garante:
//   - CONFIRMADO (`refunded_cents` / `refunded_amount`): valor que o Stripe já
//     devolveu. Fonte autoritativa = Stripe. Só cresce (monotônico) e é escrito
//     exclusivamente pelos caminhos de confirmação (webhook / reconciliador).
//   - RESERVADO (`refund_reserved_cents`): montante comprometido por
//     solicitações ainda pendentes. Nunca é confundido com dinheiro devolvido.
//   - COMPROMETIDO (`refund_committed_cents`) = confirmado + reservado. É o
//     ÚNICO portão do teto de estorno (uma conta só, escrita atomicamente).
//   - `refund_reservation_ids`: tokens de propriedade. O ID da RefundRequest é o
//     dono da reserva — a liberação é um CAS por token na MESMA escrita do
//     decremento (uma reserva nunca libera outra, nunca é liberada duas vezes).
//
// Todas as operações são UM `updateMany` condicional em UM documento do
// Payment: checagem do teto, contadores e token mudam juntos ou não mudam.
// Não existe leitura-seguida-de-escrita no caminho crítico.

const cents = (v: any): number => Math.round((Number(v) || 0) * 100);

export function paidCents(payment: any): number {
  return Math.round(Number(payment?.amount_cents) || 0) || cents(payment?.amount);
}

export function confirmedCents(payment: any): number {
  if (payment && payment.refunded_cents != null) return Math.round(Number(payment.refunded_cents) || 0);
  return cents(payment?.refunded_amount);
}

export function reservedCents(payment: any): number {
  return Math.round(Number(payment?.refund_reserved_cents) || 0);
}

export function committedCents(payment: any): number {
  if (payment && payment.refund_committed_cents != null) {
    return Math.max(0, Math.round(Number(payment.refund_committed_cents) || 0));
  }
  return confirmedCents(payment) + reservedCents(payment);
}

// Saldo disponível para uma NOVA reserva (pago − comprometido).
export function availableRefundCents(payment: any): number {
  return Math.max(0, paidCents(payment) - committedCents(payment));
}

// Normalização única de pagamentos legados: sem `refunded_cents`, o confirmado
// é o `refunded_amount` existente (que até a Fase 1 misturava reserva e
// confirmado — com zero solicitações pendentes, o valor gravado é confirmado).
async function ensureLedger(svc: any, payment: any): Promise<any> {
  if (!payment?.id) return payment;
  if (payment.refunded_cents != null && payment.refund_committed_cents != null) return payment;
  const confirmed = cents(payment.refunded_amount);
  try {
    await svc.entities.Payment.updateMany(
      { id: payment.id, refunded_cents: { $exists: false } },
      {
        $set: {
          refunded_cents: confirmed,
          refund_reserved_cents: Math.round(Number(payment.refund_reserved_cents) || 0),
          refund_committed_cents: confirmed + Math.round(Number(payment.refund_reserved_cents) || 0),
        },
      }
    );
  } catch (err: any) {
    console.error("[refundLedger] normalização do ledger falhou:", err?.message || err);
  }
  const fresh = (await svc.entities.Payment.filter({ id: payment.id }))[0];
  return fresh || payment;
}

// CLAIM da reserva: reserva `amountCents` para `requestId` SOMENTE se
// comprometido + valor não ultrapassar o pago. Contadores e token na mesma
// escrita atômica — duas solicitações concorrentes jamais reservam acima do
// saldo, e a reserva nasce com dono.
export async function claimRefundReservation(
  svc: any,
  payment: any,
  requestId: string,
  amountCents: number,
): Promise<{ ok: boolean; reason: string }> {
  const amount = Math.round(Number(amountCents) || 0);
  if (!payment?.id) return { ok: false, reason: "Pagamento inexistente." };
  if (!requestId) return { ok: false, reason: "Solicitação sem identidade para reservar valor." };
  if (amount <= 0) return { ok: false, reason: "Valor de reserva inválido." };

  const fresh = await ensureLedger(svc, payment);
  const cap = paidCents(fresh) - amount;

  const claim = await svc.entities.Payment.updateMany(
    {
      id: fresh.id,
      refund_reservation_ids: { $ne: requestId },
      $or: [
        { refund_committed_cents: { $lte: cap } },
        { refund_committed_cents: { $exists: false } },
      ],
    },
    {
      $inc: { refund_committed_cents: amount, refund_reserved_cents: amount },
      $push: { refund_reservation_ids: requestId },
    },
  );
  if (!claim || !claim.updated) {
    return { ok: false, reason: "Teto de estorno já comprometido por outra solicitação." };
  }
  return { ok: true, reason: "" };
}

// LIBERAÇÃO por IDENTIDADE: só o dono da reserva libera, só uma vez.
// O CAS exige o token na MESMA escrita do decremento — reexecução e
// concorrência convergem para o mesmo estado, e o valor confirmado (outro
// contador) nunca é tocado por uma liberação.
export async function releaseRefundReservation(
  svc: any,
  paymentId: string,
  requestId: string,
  amountCents: number,
): Promise<{ released: boolean }> {
  const amount = Math.round(Number(amountCents) || 0);
  if (!paymentId || !requestId || amount <= 0) return { released: false };
  try {
    const res = await svc.entities.Payment.updateMany(
      {
        id: paymentId,
        refund_reservation_ids: requestId,
        refund_reserved_cents: { $gte: amount },
      },
      {
        $inc: { refund_committed_cents: -amount, refund_reserved_cents: -amount },
        $pull: { refund_reservation_ids: requestId },
      },
    );
    return { released: !!(res && res.updated) };
  } catch (err: any) {
    console.error("[refundLedger] liberação de reserva falhou:", err?.message || err);
    return { released: false };
  }
}

// Aplica o valor CONFIRMADO cumulativo do Stripe. Monotônico (evento duplicado
// ou fora de ordem nunca reduz o confirmado) e ajusta o comprometido pelo
// MESMO delta — o confirmado nunca é sobrescrito por uma reserva.
//
// `opts` permite consumir a reserva da PRÓPRIA solicitação na MESMA escrita
// (delta do confirmado + devolução da reserva + remoção do token): não existe
// janela em que o confirmado já subiu e a reserva antiga ainda conta, nem
// janela inversa (reserva liberada com confirmado atrasado). Se o token já não
// estiver lá (liberação anterior), o delta é aplicado sozinho.
export async function applyConfirmedRefundCents(
  svc: any,
  payment: any,
  cumulativeCentsInput: number,
  opts?: { releaseRequestId?: string; releaseCents?: number },
): Promise<{ ok: boolean; cents: number; applied: boolean; reason: string }> {
  const target = Math.max(0, Math.round(Number(cumulativeCentsInput) || 0));
  if (!payment?.id) return { ok: false, cents: 0, applied: false, reason: "Pagamento inexistente." };

  const releaseRequestId = opts?.releaseRequestId || "";
  const releaseAmount = releaseRequestId ? Math.round(Number(opts?.releaseCents) || 0) : 0;

  let current = await ensureLedger(svc, payment);
  let prev = confirmedCents(current);
  // Sem delta E sem reserva para consumir: evento duplicado/fora de ordem —
  // nada a fazer. Com reserva pendente, o token AINDA é consumido abaixo (a
  // confirmação já vista não pode deixar a reserva presa).
  if (target <= prev && releaseAmount <= 0) return { ok: true, cents: prev, applied: false, reason: "" };

  for (let attempt = 0; attempt < 3; attempt++) {
    const delta = Math.max(0, target - prev);

    if (releaseAmount > 0) {
      const combined = await svc.entities.Payment.updateMany(
        {
          id: payment.id,
          refunded_cents: prev,
          refund_reservation_ids: releaseRequestId,
          refund_reserved_cents: { $gte: releaseAmount },
        },
        {
          $set: { refunded_cents: target, refunded_amount: target / 100 },
          $inc: { refund_committed_cents: delta - releaseAmount, refund_reserved_cents: -releaseAmount },
          $pull: { refund_reservation_ids: releaseRequestId },
        },
      );
      if (combined && combined.updated) {
        return { ok: true, cents: Math.max(prev, target), applied: delta > 0, reason: "" };
      }
      // Token já liberado (ou reserva divergente): segue com o delta simples.
    }

    if (delta <= 0) return { ok: true, cents: prev, applied: false, reason: "" };

    const claim = await svc.entities.Payment.updateMany(
      { id: payment.id, refunded_cents: prev },
      {
        $set: { refunded_cents: target, refunded_amount: target / 100 },
        $inc: { refund_committed_cents: delta },
      },
    );
    if (claim && claim.updated) return { ok: true, cents: target, applied: true, reason: "" };
    const fresh = (await svc.entities.Payment.filter({ id: payment.id }))[0];
    if (!fresh) return { ok: false, cents: prev, applied: false, reason: "Pagamento não encontrado." };
    prev = confirmedCents(fresh);
    if (target <= prev) return { ok: true, cents: prev, applied: false, reason: "" };
  }
  return { ok: false, cents: prev, applied: false, reason: "Concorrência: confirmado não aplicado nesta rodada." };
}