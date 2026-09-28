// FIN-001 (r2) — Lock atômico de exclusividade de checkout (comprador + evento).
//
// r2 (2026-09-28): locks SIMULTÂNEOS e INDEPENDENTES por (comprador, evento).
// O lock único anterior (campos escalares na Person) permitia reabrir a
// corrida quando o mesmo comprador alternava eventos: checkout A → lock A;
// checkout B sobrescrevia para B; nova chamada A readquiria A enquanto B
// seguia pendente — dois checkouts pagáveis no mesmo evento.
//
// Portão atômico: Person.checkout_lock_events (array de event_ids) — o CAS
//   { checkout_lock_events: { $ne: eventId } } + $push
// garante EXATAMENTE um vencedor por evento em corrida (primitiva $ne+$push
// da mesma família do registro de cupons — DAT-001, validada em produção
// 2026-09-28) e NÃO interfere entre eventos distintos (A e B coexistem).
// Detalhes do lock (pedido pendente, TTL) ficam na entidade CheckoutLock,
// escritos APENAS pelo vencedor do portão — sem corrida de escrita.
//
// Campos escalares legados (checkout_lock_event_id/order_id/expires_at) são
// mantidos por histórico: NENHUM código os lê ou escreve desde r2.
//
// Semântica:
//   - claimCheckoutLock: portão CAS; portão travado + registro ativo não
//     vencido → { ok:false, pendingOrderId } (recheckout reusa o pedido
//     pendente apontado; sem pedido → 409 imediato no chamador); registro
//     vencido por TTL ou ausente (crash pós-portão) → libera SOMENTE este
//     evento e readquire (recuperação sem locks órfãos).
//   - attachCheckoutLock: liga o lock vivo ao pedido criado/reusado e renova
//     o TTL; cria o registro se o vencedor ainda não o fez (autocura).
//   - releaseCheckoutLock: idempotente e ESCOPADO por evento — libera em
//     falha do checkout, cancelamento/expiração (expirador) e pagamento
//     confirmado (fulfillment), sem tocar locks de outros eventos.
//
// O lock é camada PRÉ-Order: o CAS do pedido (reuso + dedup pós-create)
// permanece como defesa secundária — nunca removê-lo. Observado ao vivo em
// 2026-09-28: lag de visibilidade do registro pode levar um concorrente ao
// caminho stale_orphan enquanto o vencedor legitimo ainda está criando o
// registro — nesse caso o vencedor tem o gate liberado por baixo dos panos,
// MAS o CAS do pedido é o árbitro final: a corrida terminou 1×200 + 1×409
// com exatamente um checkout pagável e nenhum lock órfão. A janela de
// tolerância (REGISTRY_SETTLE_*) reduz, não elimina, esse caso raro.

export const CHECKOUT_LOCK_TTL_MS = 15 * 60 * 1000;

// Tolerância para o vencedor do portão criar/atualizar o registro CheckoutLock:
// sem isto, um concorrente trataria "portão travado sem registro" como crash e
// liberaria o lock de um claim legítimo em pleno voo (janela de milissegundos
// entre o $push do portão e o create do registro).
const REGISTRY_SETTLE_RETRIES = 3;
const REGISTRY_SETTLE_DELAY_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Escrito apenas pelo vencedor do portão (sem corrida de escrita): reutiliza o
// registro ativo DESTE evento ou cria um novo. Nenhum registro 'released' é
// reutilizado (histórico preservado).
async function upsertActiveLockRecord(svc: any, personId: string, eventId: string, userId: string, orderId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + CHECKOUT_LOCK_TTL_MS).toISOString();
  const upd = await svc.entities.CheckoutLock.updateMany(
    { person_id: personId, event_id: eventId, status: 'active' },
    { $set: { order_id: orderId, expires_at: expiresAt } }
  );
  if (!upd || !upd.updated) {
    await svc.entities.CheckoutLock.create({
      person_id: personId,
      event_id: eventId,
      user_id: userId || '',
      order_id: orderId,
      expires_at: expiresAt,
      status: 'active',
      released_reason: '',
    });
  }
}

// Retorna { ok: true } com o lock adquirido; { ok: true, skipped: true } quando
// o comprador não tem Person (o CAS do Order segue garantindo exclusividade);
// { ok: false, pendingOrderId } quando há lock vivo DESTE evento — com pedido
// apontado o chamador segue pelo reuso atômico; sem pedido (checkout em pleno
// voo) o chamador devolve 409 imediato.
export async function claimCheckoutLock(svc: any, personId: string, eventId: string, userId: string = ''): Promise<{ ok: boolean; skipped?: boolean; pendingOrderId?: string }> {
  if (!personId || !eventId) return { ok: true, skipped: true };

  const gateQuery = { id: personId, checkout_lock_events: { $ne: eventId } };
  const gatePush = { $push: { checkout_lock_events: eventId } };

  // Portão — tentativa 1: evento não travado (eventos distintos coexistem).
  const gate = await svc.entities.Person.updateMany(gateQuery, gatePush);
  if (gate && gate.updated) {
    await upsertActiveLockRecord(svc, personId, eventId, userId, '');
    return { ok: true };
  }

  // Portão travado DESTE evento: lê o registro vivo (com tolerância à janela
  // de criação do vencedor) para decidir reuso, TTL vencido ou conflito.
  let lockRow: any = null;
  for (let i = 0; i < REGISTRY_SETTLE_RETRIES; i++) {
    lockRow = (await svc.entities.CheckoutLock.filter({
      person_id: personId,
      event_id: eventId,
      status: 'active',
      is_deleted: false,
    }))[0];
    if (lockRow) break;
    await sleep(REGISTRY_SETTLE_DELAY_MS);
  }
  if (lockRow && (!lockRow.expires_at || new Date(lockRow.expires_at).getTime() > Date.now())) {
    return { ok: false, pendingOrderId: lockRow.order_id || '' };
  }

  // Registro vencido (TTL) ou ausente (crash pós-portão): libera SOMENTE este
  // evento e reivindica. Em corrida de recuperação há exatamente um vencedor
  // (mesmo CAS) — nunca dois claims simultâneos para o mesmo par.
  await releaseCheckoutLock(svc, personId, eventId, lockRow ? 'expired' : 'stale_orphan');
  const retry = await svc.entities.Person.updateMany(gateQuery, gatePush);
  if (retry && retry.updated) {
    await upsertActiveLockRecord(svc, personId, eventId, userId, '');
    return { ok: true };
  }
  return { ok: false };
}

// Liga o lock vivo ao pedido ativo (reuso ou recém-criado) e renova o TTL — o
// pedido renovou a janela de reserva, o lock acompanha. Só o vencedor do portão
// chama (autocura: cria o registro se o claim não conseguiu criá-lo).
export async function attachCheckoutLock(svc: any, personId: string, eventId: string, orderId: string): Promise<void> {
  if (!personId || !eventId || !orderId) return;
  try {
    await upsertActiveLockRecord(svc, personId, eventId, '', orderId);
  } catch {}
}

// Idempotente e escopado por evento: o $pull só casa enquanto o evento está no
// portão (segunda chamada é no-op) e o registro só é encerrado enquanto está
// 'active'. Locks de OUTROS eventos permanecem intactos.
export async function releaseCheckoutLock(svc: any, personId: string, eventId: string, reason: string = 'released'): Promise<void> {
  if (!personId || !eventId) return;
  try {
    await svc.entities.Person.updateMany(
      { id: personId, checkout_lock_events: eventId },
      { $pull: { checkout_lock_events: eventId } }
    );
  } catch {}
  try {
    await svc.entities.CheckoutLock.updateMany(
      { person_id: personId, event_id: eventId, status: 'active' },
      { $set: { status: 'released', released_reason: reason } }
    );
  } catch {}
}