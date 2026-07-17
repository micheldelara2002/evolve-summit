import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { eventId, participantId, itemId, personId } = await req.json();

    if (!eventId || !participantId || !itemId) {
      return Response.json({ error: 'Parâmetros obrigatórios ausentes.' }, { status: 400 });
    }

    // 1. Fetch the item FRESH from DB (not client cache)
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

    // 2. Fetch participant fresh
    const participants = await base44.asServiceRole.entities.Participant.filter({
      id: participantId,
      event_id: eventId,
      is_deleted: false,
    });

    if (!participants.length) {
      return Response.json({ error: 'Participante não encontrado.' }, { status: 404 });
    }

    const participant = participants[0];

    // 3. Fetch all non-cancelled redemptions for this participant (fresh data)
    const allRedemptions = await base44.asServiceRole.entities.StoreRedemption.filter({
      event_id: eventId,
      participant_id: participantId,
      is_deleted: false,
      status: { $ne: 'cancelado' },
    });

    // 4. Check points balance
    const totalResgatado = allRedemptions.reduce((acc, r) => acc + (r.pontos_debitados || 0), 0);
    const pontosDisponiveis = Math.max(0, (participant.points_total || 0) - totalResgatado);

    if (pontosDisponiveis < item.pontos_necessarios) {
      return Response.json({ error: 'Saldo insuficiente para resgate.' }, { status: 400 });
    }

    // 5. Check per-user limit (fresh data — minimizes race window)
    if (item.limite_por_usuario) {
      const myItemRedemptions = allRedemptions.filter((r) => r.store_item_id === itemId);
      if (myItemRedemptions.length >= item.limite_por_usuario) {
        return Response.json({
          error: `Limite de ${item.limite_por_usuario} resgate(s) por participante atingido.`,
        }, { status: 400 });
      }
    }

    // 6. ATOMIC stock decrement — conditional update
    // Only increments if quantidade_resgatada < estoque_total
    // MongoDB serializes document-level writes, so concurrent $inc operations are safe:
    // the second request's filter will no longer match after the first $inc lands.
    const prevQtde = qtdeResgatada;
    await base44.asServiceRole.entities.StoreItem.updateMany(
      { id: itemId, quantidade_resgatada: { $lt: estoqueTotal } },
      { $inc: { quantidade_resgatada: 1 } }
    );

    // 7. Verify the increment actually took effect (guards against race conditions)
    const updatedItems = await base44.asServiceRole.entities.StoreItem.filter({ id: itemId });
    const updatedItem = updatedItems[0];
    if (!updatedItem || (updatedItem.quantidade_resgatada ?? 0) <= prevQtde) {
      // Another request grabbed the last unit between our read and the conditional update
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
        status: 'pendente',
      });
    } catch (createErr) {
      // Roll back the stock increment if redemption creation fails
      await base44.asServiceRole.entities.StoreItem.updateMany(
        { id: itemId },
        { $inc: { quantidade_resgatada: -1 } }
      );
      return Response.json({ error: 'Erro ao registrar resgate.' }, { status: 500 });
    }

    return Response.json({
      success: true,
      redemption,
      pontosDisponiveis: pontosDisponiveis - item.pontos_necessarios,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});