import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

// P0.3 + P0 residual — Points/Redemption integrity.
//
// No native ACID transactions between entities. Strategy: idempotency + compensation.
//
// CORE PRINCIPLE (P0 residual fix): Each request takes responsibility for ITS OWN
// redemption ONLY. A request never cancels or rolls back another request's
// redemption. This prevents double-rollback when two concurrent requests both
// detect the same duplicate/overflow — each cancels only its own, so each
// stock +1 is undone at most once.
//
// Concurrent same-key guarantee:
//   Two simultaneous requests with the same idempotency_key cannot both keep
//   their redemptions. After creating, we re-query by chave_idempotencia. If >1
//   exists, we sort by (created_date, id) and identify the single survivor
//   (earliest). If THIS request's redemption is NOT the survivor, it cancels
//   its own redemption + conditional stock rollback ($gt: 0). The survivor
//   keeps its redemption and stock. Result: exactly 1 valid redemption, stock +1.
//
// Balance overflow guarantee:
//   After same-key dedup, we re-query all non-cancelled redemptions. If total
//   debited > points_total, we sort by (created_date, id) and identify which
//   redemptions pushed the total over (the latest ones). If THIS request's
//   redemption is among the overflow, it cancels its own + conditional stock
//   rollback. Non-overflow redemptions are never touched.
//
// Conditional stock rollback ($gt: 0) ensures stock never goes negative even
// if a rollback races with another decrement.
//
// P0.3 residual refinements:
//   1. Stock reservation success is determined by updateMany's returned `updated`
//      count (updated > 0 = THIS request's $inc was applied), NOT by comparing
//      pre/post values — a concurrent request's increment could be misattributed.
//   2. idempotency_key is bound to operation context (event + participant + item).
//      A key reused for a different operation returns 409 conflict, never
//      returns another operation's redemption.
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { eventId, participantId, itemId, personId, idempotency_key } = await req.json();

    if (!eventId || !participantId || !itemId) {
      return Response.json({ error: 'Parâmetros obrigatórios ausentes.' }, { status: 400 });
    }

    if (!idempotency_key) {
      return Response.json({ error: 'idempotency_key é obrigatória.' }, { status: 400 });
    }

    // Replay-safe — bind idempotency_key to operation context (event + participant + item).
    // A key is only valid for the SAME (event, participant, item) that originally created it.
    // If the same key is presented for a different operation, return 409 conflict — never
    // return another operation's redemption.
    const existingByKey = await base44.asServiceRole.entities.StoreRedemption.filter({
      chave_idempotencia: idempotency_key,
      is_deleted: false,
      status: { $ne: 'cancelado' },
    });
    if (existingByKey.length > 0) {
      const existing = existingByKey[0];
      const contextMatches =
        existing.event_id === eventId &&
        existing.participant_id === participantId &&
        existing.store_item_id === itemId;
      if (!contextMatches) {
        return Response.json({ error: 'Conflito de idempotência: chave já utilizada em outra operação.' }, { status: 409 });
      }
      return Response.json({ success: true, redemption: existing, idempotent_replay: true });
    }

    // 1. Fetch the item FRESH from DB
    const items = await base44.asServiceRole.entities.StoreItem.filter({
      id: itemId,
      event_id: eventId,
      is_deleted: false,
      status: 'ativo',
    });
    if (!items.length) {
      return Response.json({ error: 'Item não encontrado ou indisponível.' }, { status: 404 });
    }
    const item = items[0];
    const estoqueTotal = item.estoque_total ?? 0;
    const qtdeResgatada = item.quantidade_resgatada ?? 0;
    const estoqueDisp = Math.max(0, estoqueTotal - qtdeResgatada);
    if (estoqueDisp === 0) {
      return Response.json({ error: 'Item esgotado.' }, { status: 409 });
    }

    // 2. Fetch participant fresh — event_id in query prevents cross-event
    const participants = await base44.asServiceRole.entities.Participant.filter({
      id: participantId,
      event_id: eventId,
      is_deleted: false,
    });
    if (!participants.length) {
      return Response.json({ error: 'Participante não encontrado neste evento.' }, { status: 404 });
    }
    const participant = participants[0];

    // Ownership check
    if (participant.email !== user.email && user.role !== 'admin') {
      return Response.json({ error: 'Sem permissão para resgatar itens para este participante.' }, { status: 403 });
    }

    // 3. Fetch all non-cancelled redemptions (fresh)
    const allRedemptions = await base44.asServiceRole.entities.StoreRedemption.filter({
      event_id: eventId,
      participant_id: participantId,
      is_deleted: false,
      status: { $ne: 'cancelado' },
    });

    // 4. Points balance check
    const totalResgatado = allRedemptions.reduce((acc, r) => acc + (r.pontos_debitados || 0), 0);
    const pontosDisponiveis = Math.max(0, (participant.points_total || 0) - totalResgatado);
    if (pontosDisponiveis < item.pontos_necessarios) {
      return Response.json({ error: 'Saldo insuficiente para resgate.' }, { status: 400 });
    }

    // 5. Per-user limit
    if (item.limite_por_usuario) {
      const myItemRedemptions = allRedemptions.filter((r) => r.store_item_id === itemId);
      if (myItemRedemptions.length >= item.limite_por_usuario) {
        return Response.json({ error: `Limite de ${item.limite_por_usuario} resgate(s) por participante atingido.` }, { status: 400 });
      }
    }

    // 6. ATOMIC stock reservation — conditional $inc (quantidade_resgatada < estoque_total).
    //    updateMany returns { updated: N }. updated > 0 means THIS request's own
    //    $inc was applied by the database. We do NOT infer success by comparing
    //    pre/post values (a concurrent request's increment could be misattributed).
    //    updated === 0 means the condition (quantidade_resgatada < estoque_total)
    //    was not met — stock was full, this request did NOT get a reservation.
    const incResult = await base44.asServiceRole.entities.StoreItem.updateMany(
      { id: itemId, quantidade_resgatada: { $lt: estoqueTotal } },
      { $inc: { quantidade_resgatada: 1 } }
    );
    if (!incResult || (incResult.updated ?? 0) === 0) {
      return Response.json({ error: 'Item esgotado. Tente outro item.' }, { status: 409 });
    }

    // 8. Create the redemption record
    let redemption;
    try {
      redemption = await base44.asServiceRole.entities.StoreRedemption.create({
        event_id: eventId,
        participant_id: participantId,
        person_id: personId || undefined,
        store_item_id: itemId,
        item_description: item.descricao_item,
        pontos_debitados: item.pontos_necessarios,
        chave_idempotencia: idempotency_key,
        status: 'pendente',
      });
    } catch (createErr) {
      // Rollback stock if creation fails (conditional — never negative)
      await base44.asServiceRole.entities.StoreItem.updateMany(
        { id: itemId, quantidade_resgatada: { $gt: 0 } },
        { $inc: { quantidade_resgatada: -1 } }
      );
      return Response.json({ error: 'Erro ao registrar resgate.' }, { status: 500 });
    }

    // 9. P0 residual — Concurrent same-key dedup.
    //    Two simultaneous requests with the same key may both create. We identify
    //    the single survivor (earliest by created_date, then id). If THIS request's
    //    redemption is NOT the survivor, it cancels ITS OWN redemption + rolls back
    //    ITS OWN stock increment. The survivor is never touched by another request.
    const sameKeyRedemptions = await base44.asServiceRole.entities.StoreRedemption.filter({
      chave_idempotencia: idempotency_key,
      event_id: eventId,
      participant_id: participantId,
      is_deleted: false,
      status: { $ne: 'cancelado' },
    });
    if (sameKeyRedemptions.length > 1) {
      const sorted = [...sameKeyRedemptions].sort((a, b) => {
        const dc = new Date(a.created_date) - new Date(b.created_date);
        return dc !== 0 ? dc : a.id.localeCompare(b.id);
      });
      const survivor = sorted[0];

      if (redemption.id !== survivor.id) {
        // This request's redemption is the duplicate — cancel own + rollback own stock
        await base44.asServiceRole.entities.StoreRedemption.update(redemption.id, { status: 'cancelado' });
        await base44.asServiceRole.entities.StoreItem.updateMany(
          { id: itemId, quantidade_resgatada: { $gt: 0 } },
          { $inc: { quantidade_resgatada: -1 } }
        );
        return Response.json({ success: true, redemption: survivor, idempotent_replay: true });
      }
      // This request's redemption is the survivor — keep it, no rollback needed
    }

    // 10. P0 residual — Balance overflow compensation.
    //     Re-fetch ALL non-cancelled redemptions. If total > points_total, sort by
    //     (created_date, id) and identify which redemptions overflow. If THIS
    //     request's redemption is among the overflow, cancel ITS OWN + rollback.
    //     Non-overflow redemptions are never touched by this request.
    const allRedemptionsAfter = await base44.asServiceRole.entities.StoreRedemption.filter({
      event_id: eventId,
      participant_id: participantId,
      is_deleted: false,
      status: { $ne: 'cancelado' },
    });
    const sortedAfter = [...allRedemptionsAfter].sort((a, b) => {
      const dc = new Date(a.created_date) - new Date(b.created_date);
      return dc !== 0 ? dc : a.id.localeCompare(b.id);
    });
    let cumulative = 0;
    let myRedemptionOverflowed = false;
    for (const r of sortedAfter) {
      cumulative += (r.pontos_debitados || 0);
      if (cumulative > (participant.points_total || 0)) {
        if (r.id === redemption.id) {
          myRedemptionOverflowed = true;
        }
      }
    }
    if (myRedemptionOverflowed) {
      // This request's redemption caused the overflow — cancel own + rollback own stock
      await base44.asServiceRole.entities.StoreRedemption.update(redemption.id, { status: 'cancelado' });
      await base44.asServiceRole.entities.StoreItem.updateMany(
        { id: itemId, quantidade_resgatada: { $gt: 0 } },
        { $inc: { quantidade_resgatada: -1 } }
      );
      return Response.json({ error: 'Saldo insuficiente após verificação de consistência.' }, { status: 400 });
    }

    // Recalculate available points after compensation
    const finalRedemptions = await base44.asServiceRole.entities.StoreRedemption.filter({
      event_id: eventId,
      participant_id: participantId,
      is_deleted: false,
      status: { $ne: 'cancelado' },
    });
    const finalDebited = finalRedemptions.reduce((acc, r) => acc + (r.pontos_debitados || 0), 0);

    return Response.json({
      success: true,
      redemption,
      pontosDisponiveis: Math.max(0, (participant.points_total || 0) - finalDebited),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});