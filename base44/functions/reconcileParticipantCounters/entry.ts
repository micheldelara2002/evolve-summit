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
// Pagination: skip + limit (BATCH_SIZE=500), deterministic sort by '-id'.
// Cursor pagination on 'id' via $lt/$gt does NOT work in the Base44 SDK — this
// is the same skip-based pattern validated in reconcileBusinessMetrics /
// reconcileGlobalMetrics. Memory is O(batch) in every path; ledgers are paged
// so there is no arbitrary truncation limit.
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

const BATCH_SIZE = 500;

// =============================================================================
// Paginated sum of a ledger for a single participant. O(batch) memory.
// =============================================================================
async function sumParticipantLedger(svc, entity, participantId, filterExtra, valueField) {
  let sum = 0;
  let skip = 0;
  while (true) {
    const batch = await svc.entities[entity].filter(
      { participant_id: participantId, ...filterExtra }, '-id', BATCH_SIZE, skip
    );
    if (batch.length === 0) break;
    for (const r of batch) sum += (r[valueField] || 0);
    skip += BATCH_SIZE;
    if (batch.length < BATCH_SIZE) break;
  }
  return sum;
}

// =============================================================================
// Paginated sum of a ledger for a batch of participants (participant_id $in).
// Returns a Map<participant_id, sum>. O(batch) memory — paged by skip+limit.
// =============================================================================
async function sumBatchLedger(svc, entity, eventId, batchIds, filterExtra, valueField) {
  const map = new Map();
  let skip = 0;
  while (true) {
    const batch = await svc.entities[entity].filter(
      { event_id: eventId, participant_id: { $in: batchIds }, ...filterExtra },
      '-id', BATCH_SIZE, skip
    );
    if (batch.length === 0) break;
    for (const r of batch) {
      if (!r.participant_id) continue;
      map.set(r.participant_id, (map.get(r.participant_id) || 0) + (r[valueField] || 0));
    }
    skip += BATCH_SIZE;
    if (batch.length < BATCH_SIZE) break;
  }
  return map;
}

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

    const svc = base44.asServiceRole;

    // === Single participant ===
    if (participantId) {
      const [participant] = await svc.entities.Participant.filter({
        id: participantId, is_deleted: false,
      });
      if (!participant) return Response.json({ error: 'Participante não encontrado.' }, { status: 404 });

      // Ledger sums are paginated (skip+limit, BATCH_SIZE=500) — no truncation.
      const computedPoints = await sumParticipantLedger(
        svc, 'PointTransaction', participantId, {}, 'pontos'
      );
      const computedRedeemed = await sumParticipantLedger(
        svc, 'StoreRedemption', participantId,
        { is_deleted: false, status: { $ne: 'cancelado' } }, 'pontos_debitados'
      );

      const before = { points_total: participant.points_total || 0, redeemed_total: participant.redeemed_total || 0 };
      const drift = {
        points: computedPoints - before.points_total,
        redeemed: computedRedeemed - before.redeemed_total,
      };

      const hasDrift = drift.points !== 0 || drift.redeemed !== 0;
      if (!dryRun && hasDrift) {
        await svc.entities.Participant.update(participantId, {
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

    // === Event-wide — skip-based pagination (BATCH_SIZE=500, sort '-id') ===
    // Memory is O(batch): each participant batch loads ≤500 participants, then
    // pages through their ledgers (participant_id $in batch) in pages of 500.
    // No cursor on 'id' (unsupported by SDK). No arbitrary ledger limit.
    let totalReconciled = 0;
    let totalDrifted = 0;
    let totalApplied = 0;
    const allDetails = [];
    let skipPart = 0;

    while (true) {
      const partBatch = await svc.entities.Participant.filter(
        { event_id: eventId, is_deleted: false }, '-id', BATCH_SIZE, skipPart
      );
      if (partBatch.length === 0) break;
      skipPart += BATCH_SIZE;
      totalReconciled += partBatch.length;

      const batchIds = partBatch.map((p) => p.id);

      // Paginated ledger sums for THIS participant batch only — O(batch) memory.
      const pointsMap = await sumBatchLedger(
        svc, 'PointTransaction', eventId, batchIds, {}, 'pontos'
      );
      const redeemedMap = await sumBatchLedger(
        svc, 'StoreRedemption', eventId, batchIds,
        { is_deleted: false, status: { $ne: 'cancelado' } }, 'pontos_debitados'
      );

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
        await svc.entities.Participant.bulkUpdate(toUpdate);
        totalApplied += toUpdate.length;
      }

      if (partBatch.length < BATCH_SIZE) break;
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