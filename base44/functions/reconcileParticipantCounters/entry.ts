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

    // === Event-wide ===
    const [participants, txs, redemptions] = await Promise.all([
      base44.asServiceRole.entities.Participant.filter({ event_id: eventId, is_deleted: false }, '-created_date', 10000),
      base44.asServiceRole.entities.PointTransaction.filter({ event_id: eventId }, '-created_date', 20000),
      base44.asServiceRole.entities.StoreRedemption.filter({
        event_id: eventId, is_deleted: false, status: { $ne: 'cancelado' },
      }, '-created_date', 20000),
    ]);

    // Group ledgers by participant_id
    const pointsByParticipant = new Map();
    txs.forEach((t) => {
      if (!t.participant_id) return;
      pointsByParticipant.set(t.participant_id, (pointsByParticipant.get(t.participant_id) || 0) + (t.pontos || 0));
    });
    const redeemedByParticipant = new Map();
    redemptions.forEach((r) => {
      if (!r.participant_id) return;
      redeemedByParticipant.set(r.participant_id, (redeemedByParticipant.get(r.participant_id) || 0) + (r.pontos_debitados || 0));
    });

    const details = [];
    const toUpdate = [];
    let drifted = 0;

    for (const p of participants) {
      const computedPoints = pointsByParticipant.get(p.id) || 0;
      const computedRedeemed = redeemedByParticipant.get(p.id) || 0;
      const before = { points_total: p.points_total || 0, redeemed_total: p.redeemed_total || 0 };
      const drift = {
        points: computedPoints - before.points_total,
        redeemed: computedRedeemed - before.redeemed_total,
      };

      const hasDrift = drift.points !== 0 || drift.redeemed !== 0;
      if (hasDrift) {
        drifted++;
        toUpdate.push({ id: p.id, points_total: computedPoints, redeemed_total: computedRedeemed });
      }

      // Only include drifted participants in details to keep response focused
      if (hasDrift) {
        details.push({
          participantId: p.id,
          name: p.full_name,
          before,
          after: { points_total: computedPoints, redeemed_total: computedRedeemed },
          drift,
        });
      }
    }

    // Apply updates in batches of 500 (SDK bulkUpdate limit)
    if (!dryRun && toUpdate.length > 0) {
      for (let i = 0; i < toUpdate.length; i += 500) {
        const batch = toUpdate.slice(i, i + 500);
        await base44.asServiceRole.entities.Participant.bulkUpdate(batch);
      }
    }

    return Response.json({
      scope: 'event',
      eventId,
      reconciled: participants.length,
      drifted,
      applied: !dryRun && toUpdate.length > 0,
      details: details.slice(0, 100), // cap response size; only drifted participants
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});