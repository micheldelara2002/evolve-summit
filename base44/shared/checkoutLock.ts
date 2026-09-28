// FIN-001 — Lock atômico de exclusividade de checkout (comprador + evento).
//
// Ancorado na PERSON do comprador: todo usuário do app ganha uma Person no
// cadastro (workflow "Criar Person no Cadastro") e Person.updateMany suporta
// CAS condicional — a plataforma BLOQUEIA updateMany na entidade User
// ("Bulk user update not allowed", 405), então o User não pode ancorar o lock.
//
// Primitivo validado em produção (2026-09-28, scratch + claims concorrentes):
//   - { checkout_lock_event_id: { $ne: eventId } } + $set → EXATAMENTE um
//     vencedor entre requisições concorrentes do mesmo comprador/evento.
//   - Release condicional por (person, event) é idempotente: a segunda
//     chamada não casa (campo já vazio) e não altera nada.
//
// Semântica:
//   - claimCheckoutLock: CAS em duas tentativas (A: lock ausente/otro
//     evento/liberado; B: lock do MESMO evento porém vencido por TTL).
//     TTL = janela de reserva do checkout (15 min) — impede locks órfãos.
//   - attachCheckoutLock: liga o lock vivo ao pedido criado/reusado; o
//     recheckout normal (mesma conta, checkout anterior ainda pendente) cai
//     no caminho de reuso atômico do pedido apontado pelo lock.
//   - releaseCheckoutLock: idempotente — liberado em falha do checkout,
//     cancelamento/expiração (expirador) e pagamento confirmado (fulfillment).
//
// O lock é camada PRÉ-Order: o CAS do pedido (reuso + dedup pós-create)
// permanece como defesa secundária — nunca removê-lo.

export const CHECKOUT_LOCK_TTL_MS = 15 * 60 * 1000;

// Retorna { ok: true } com o lock adquirido, { ok: true, skipped: true }
// quando o comprador não tem Person (lock indisponível — o CAS do Order
// continua garantindo exclusividade) ou { ok: false } quando há lock vivo
// para o mesmo evento (concorrente em andamento).
export async function claimCheckoutLock(svc: any, personId: string, eventId: string): Promise<{ ok: boolean; skipped?: boolean }> {
  if (!personId || !eventId) return { ok: true, skipped: true };
  const expiresAt = new Date(Date.now() + CHECKOUT_LOCK_TTL_MS).toISOString();
  const baseSet = { checkout_lock_event_id: eventId, checkout_lock_order_id: "", checkout_lock_expires_at: expiresAt };
  // Tentativa A — lock ausente, liberado ou de outro evento (last-writer-wins
  // entre eventos distintos; dentro do MESMO evento o CAS garante um vencedor).
  const a = await svc.entities.Person.updateMany(
    { id: personId, checkout_lock_event_id: { $ne: eventId } },
    { $set: baseSet }
  );
  if (a && a.updated) return { ok: true };
  // Tentativa B — lock DESTE evento, porém vencido (TTL): readquire.
  const b = await svc.entities.Person.updateMany(
    { id: personId, checkout_lock_expires_at: { $lt: new Date().toISOString() } },
    { $set: baseSet }
  );
  if (b && b.updated) return { ok: true };
  return { ok: false };
}

// Liga o lock vivo ao pedido ativo (estende o TTL junto — o pedido renovou a
// janela de reserva, o lock acompanha).
export async function attachCheckoutLock(svc: any, personId: string, eventId: string, orderId: string): Promise<void> {
  if (!personId || !eventId || !orderId) return;
  try {
    await svc.entities.Person.updateMany(
      { id: personId, checkout_lock_event_id: eventId },
      { $set: { checkout_lock_order_id: orderId, checkout_lock_expires_at: new Date(Date.now() + CHECKOUT_LOCK_TTL_MS).toISOString() } }
    );
  } catch {}
}

// Idempotente: só limpa se o lock ainda for do evento informado; segunda
// chamada não casa (campo já vazio) e é no-op.
export async function releaseCheckoutLock(svc: any, personId: string, eventId: string): Promise<void> {
  if (!personId || !eventId) return;
  try {
    await svc.entities.Person.updateMany(
      { id: personId, checkout_lock_event_id: eventId },
      { $set: { checkout_lock_event_id: "", checkout_lock_order_id: "", checkout_lock_expires_at: "" } }
    );
  } catch {}
}