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

// Ledger pronto = os três contadores existem, são numéricos e o invariante do
// modelo se sustenta (comprometido = confirmado + reservado). Um registro sem
// `refund_committed_cents` NÃO está pronto: `$inc` criaria o campo e o teto
// passaria a contar só a nova reserva, ignorando o já confirmado.
export function isLedgerReady(payment: any): boolean {
  if (!payment?.id) return false;
  const numeric = (v: any) => v != null && Number.isFinite(Number(v));
  if (!numeric(payment.refunded_cents) || !numeric(payment.refund_committed_cents)) return false;
  const confirmed = Math.round(Number(payment.refunded_cents));
  const reserved = Math.round(Number(payment.refund_reserved_cents ?? 0));
  const committed = Math.round(Number(payment.refund_committed_cents));
  if (confirmed < 0 || reserved < 0 || committed < 0) return false;
  return committed === confirmed + reserved;
}

export type LedgerState = { ready: boolean; payment: any; reason: string };

// Normalização única de pagamentos legados: sem `refunded_cents`, o confirmado
// é o `refunded_amount` existente (que até a Fase 1 misturava reserva e
// confirmado — com zero solicitações pendentes, o valor gravado é confirmado).
//
// P0.1 (patch final Fase 1) — FALHA SEGURA: a normalização só é considerada
// concluída quando a escrita é confirmada E o estado persistido é relido e
// validado. Falha de escrita, campo ainda ausente ou contadores inconsistentes
// ⇒ `ready: false` e o chamador NÃO reserva nem confirma nada. Nenhuma
// atualização em massa: só o pagamento em uso, e só quando o contador falta
// (ausente ou nulo). Estado já normalizado é preservado sem reescrita.
async function ensureLedger(svc: any, payment: any): Promise<LedgerState> {
  if (!payment?.id) return { ready: false, payment: null, reason: "Pagamento inexistente." };
  if (isLedgerReady(payment)) return { ready: true, payment, reason: "" };

  const numeric = (v: any) => v != null && Number.isFinite(Number(v));
  // Contadores presentes mas inconsistentes: não é caso de migração — reescrever
  // mascararia o problema. O estado duvidoso recusa novas reservas.
  if (numeric(payment.refunded_cents) && numeric(payment.refund_committed_cents)) {
    return { ready: false, payment, reason: "Ledger de estorno inconsistente para este pagamento." };
  }

  const confirmed = cents(payment.refunded_amount);
  const reserved = Math.round(Number(payment.refund_reserved_cents) || 0);
  let writeError = "";
  try {
    await svc.entities.Payment.updateMany(
      // Ausente ou nulo: nos dois casos o contador nunca foi normalizado.
      { id: payment.id, $or: [{ refunded_cents: { $exists: false } }, { refunded_cents: null }] },
      {
        $set: {
          refunded_cents: confirmed,
          refund_reserved_cents: reserved,
          refund_committed_cents: confirmed + reserved,
        },
      }
    );
  } catch (err: any) {
    writeError = err?.message || String(err);
    console.error("[refundLedger] normalização do ledger falhou:", writeError);
  }

  // A leitura de volta é a autoridade: escrita "bem-sucedida" sem estado
  // persistido válido não conclui a normalização.
  const fresh = (await svc.entities.Payment.filter({ id: payment.id }))[0] || null;
  if (fresh && isLedgerReady(fresh)) return { ready: true, payment: fresh, reason: "" };
  return {
    ready: false,
    payment: fresh || payment,
    reason: writeError
      ? "Falha ao normalizar o ledger de estorno — nova reserva bloqueada."
      : "Ledger de estorno não confirmado após a normalização — nova reserva bloqueada.",
  };
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

  // P0.1 — ledger não normalizado/confirmado ⇒ NENHUMA escrita de reserva é
  // tentada (nem contador, nem token).
  const ledger = await ensureLedger(svc, payment);
  if (!ledger.ready) {
    return { ok: false, reason: ledger.reason || "Ledger de estorno indisponível para reservar." };
  }
  const fresh = ledger.payment;
  const cap = paidCents(fresh) - amount;

  // O teto só é comparável com o contador PRESENTE: aceitar ausência permitiria
  // `$inc` criar o campo e reservar acima do já confirmado.
  const claim = await svc.entities.Payment.updateMany(
    {
      id: fresh.id,
      refund_reservation_ids: { $ne: requestId },
      refund_committed_cents: { $lte: cap },
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

  // P0.1 — sem ledger confirmado não há confirmação de valor (o CAS abaixo
  // exigiria `refunded_cents` presente). Falha segura: nada é escrito e o caso
  // é tratado como não concluído pelo chamador.
  const ledger = await ensureLedger(svc, payment);
  if (!ledger.ready) {
    return { ok: false, cents: 0, applied: false, reason: ledger.reason || "Ledger de estorno indisponível para confirmar." };
  }
  const current = ledger.payment;
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