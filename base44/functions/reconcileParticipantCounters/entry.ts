import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// P0.2 reconciliation — Rebuild Participant counters (points_total, redeemed_total)
// from the authoritative ledgers (PointTransaction, StoreRedemption).
//
// The counters are fast-read caches maintained via atomic $inc at mutation time:
//   - points_total: incremented in processScoringAction (only for surviving txs,
//     after dedup/overflow compensation)
//   - redeemed_total: incremented in redeemStoreItem (only for the surviving
//     redemption, after same-key dedup and balance-overflow compensation)
//
// If a partial failure occurs (ledger write succeeds, $inc fails), the counter
// drifts from the ledger. This function rebuilds the counters from the ledger —
// the ledger is the source of truth, the counter is the cache.
//
// Ledger rules:
//   - points_total = SUM(PointTransaction.pontos) for the participant
//     (resgate_realizado entries have pontos=0, so they don't affect the sum;
//      duplicate txs are hard-deleted by processScoringAction, so they don't appear)
//   - redeemed_total = SUM(StoreRedemption.pontos_debitados) where
//     status != 'cancelado' AND is_deleted = false
//     (cancelled/duplicate redemptions are excluded — they were never meant to
//      debit points; in redeemStoreItem, cancellations happen BEFORE the $inc,
//      so they never reached the counter)
//
// Scope:
//   - participantId: reconcile a single participant
//   - eventId: reconcile all participants in the event
//
// Options:
//   - dryRun (default false): report drift without applying updates
//
// Authorization: admin only.
//
// Concurrency note: this sets ABSOLUTE values from a point-in-time ledger read.
// If a concurrent $inc happens after the read but before the write, it could be
// overwritten. This is an acceptable trade-off for a manual admin tool — it is
// NOT called on every read.

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admin only' }, { status: 403 });

    const { participantId, eventId, dryRun = false } = await req.json();
    if (!participantId && !eventId) {
      return Response.json({ error: 'Especifique participantId ou eventId.' }, { status: 400 });
    }

    // === Single participant ===
    if (participantId) {
      const [participant] = await base44.asServiceRole.entities.Participant.filter({
        id: participantId, is_deleted: false,
      });
      if (!participant) return Response.json({ error: 'Participante não encontrado.' }, { status: 404 });

      const [txs, redemptions] = await Promise.all([
        base44.asServiceRole.entities.PointTransaction.filter({ participant_id: participantId }, '-created_date', 10000),
        base44.asServiceRole.entities.StoreRedemption.filter({
          participant_id: participantId, is_deleted: false, status: { $ne: 'cancelado' },
        }, '-created_date', 10000),
      ]);

      const computedPoints = txs.reduce((s, t) => s + (t.pontos || 0), 0);
      const computedRedeemed = redemptions.reduce((s, r) => s + (r.pontos_debitados || 0), 0);

      const before = { points_total: participant.points_total || 0, redeemed_total: participant.redeemed_total || 0 };
      const drift = {
        points: computedPoints - before.points_total,
        redeemed: computedRedeemed - before.redeemed_total,
      };

      const hasDrift = drift.points !== 0 || drift.redeemed !== 0;
      if (!dryRun && hasDrift) {
        await base44.asServiceRole.entities.Participant.update(participantId, {
          points_total: computedPoints,
          redeemed_total: computedRedeemed,
        });
      }

      return Response.json({
        scope: 'participant',
        participantId,
        reconciled: 1,
        drifted: hasDrift ? 1 : 0,
        applied: !dryRun && hasDrift,
        details: [{
          participantId,
          name: participant.full_name,
          before,
          after: { points_total: computedPoints, redeemed_total: computedRedeemed },
          drift,
        }],
      });
    }

    // === Event-wide — batched: page through participants in bounded batches ===
    // P0.2 validation: never load all participants + ledgers at once. Each batch
    // loads ≤500 participants + their ledgers (filtered by participant_id $in),
    // keeping memory bounded regardless of event size. Cursor pagination on 'id'
    // (descending) — deterministic, single-field sort supported by the SDK.
    const BATCH_SIZE = 500;
    const LEDGER_LIMIT = 10000; // generous per-batch limit for txs/redemptions

    let cursor = null;
    let totalReconciled = 0;
    let totalDrifted = 0;
    let totalApplied = 0;
    const allDetails = [];

    while (true) {
      const partQuery = { event_id: eventId, is_deleted: false };
      if (cursor) partQuery.id = { $lt: cursor };
      const partBatch = await base44.asServiceRole.entities.Participant.filter(partQuery, '-id', BATCH_SIZE);
      if (partBatch.length === 0) break;

      cursor = partBatch[partBatch.length - 1].id;
      totalReconciled += partBatch.length;

      const batchIds = partBatch.map((p) => p.id);

      // Query ledgers for THIS batch only (bounded)
      const [batchTxs, batchRedemptions] = await Promise.all([
        base44.asServiceRole.entities.PointTransaction.filter(
          { event_id: eventId, participant_id: { $in: batchIds } }, '-id', LEDGER_LIMIT
        ),
        base44.asServiceRole.entities.StoreRedemption.filter(
          { event_id: eventId, participant_id: { $in: batchIds }, is_deleted: false, status: { $ne: 'cancelado' } },
          '-id', LEDGER_LIMIT
        ),
      ]);

      // Group ledgers by participant_id within this batch
      const pointsMap = new Map();
      batchTxs.forEach((t) => {
        if (!t.participant_id) return;
        pointsMap.set(t.participant_id, (pointsMap.get(t.participant_id) || 0) + (t.pontos || 0));
      });
      const redeemedMap = new Map();
      batchRedemptions.forEach((r) => {
        if (!r.participant_id) return;
        redeemedMap.set(r.participant_id, (redeemedMap.get(r.participant_id) || 0) + (r.pontos_debitados || 0));
      });

      // Compute drift + collect updates for this batch
      const toUpdate = [];
      for (const p of partBatch) {
        const computedPoints = pointsMap.get(p.id) || 0;
        const computedRedeemed = redeemedMap.get(p.id) || 0;
        const before = { points_total: p.points_total || 0, redeemed_total: p.redeemed_total || 0 };
        const drift = {
          points: computedPoints - before.points_total,
          redeemed: computedRedeemed - before.redeemed_total,
        };

        if (drift.points !== 0 || drift.redeemed !== 0) {
          totalDrifted++;
          toUpdate.push({ id: p.id, points_total: computedPoints, redeemed_total: computedRedeemed });
          allDetails.push({
            participantId: p.id,
            name: p.full_name,
            before,
            after: { points_total: computedPoints, redeemed_total: computedRedeemed },
            drift,
          });
        }
      }

      // Apply updates for this batch (≤500, within bulkUpdate limit)
      if (!dryRun && toUpdate.length > 0) {
        await base44.asServiceRole.entities.Participant.bulkUpdate(toUpdate);
        totalApplied += toUpdate.length;
      }
    }

    return Response.json({
      scope: 'event',
      eventId,
      reconciled: totalReconciled,
      drifted: totalDrifted,
      applied: !dryRun && totalApplied > 0,
      details: allDetails.slice(0, 100),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});