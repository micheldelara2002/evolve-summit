import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// P0.3 — Reconstrói EventStats + MetricBucket de um evento a partir das entidades
// autoritativas (Participant is_deleted:false, Lead). Admin-only, bounded por
// cursor/batches (BATCH=500). É a rede de segurança para drift nos counters.
//
// Fonte da verdade:
//   unique_participants = cardinalidade de (person_id || id) entre Participants is_deleted:false
//   total_leads         = count de Leads (append-only)
//   bucket[day]         = unique_participants criados naquele dia (is_deleted:false)
//
// dryRun=true: reporta drift sem aplicar.

function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

const BATCH = 500;

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admin only' }, { status: 403 });

    const { eventId, dryRun = false } = await req.json();
    if (!eventId) return Response.json({ error: 'eventId obrigatório' }, { status: 400 });
    const svc = base44.asServiceRole;

    // --- Pass 1: participants is_deleted:false, cursor em 'id' desc ---
    const partByDay = new Map<string, Set<string>>(); // day -> Set(person_id||id)
    let pcursor: string | null = null;
    while (true) {
      const q: any = { event_id: eventId, is_deleted: false };
      if (pcursor) q.id = { $lt: pcursor };
      const batch = await svc.entities.Participant.filter(q, '-id', BATCH);
      if (batch.length === 0) break;
      pcursor = batch[batch.length - 1].id;
      for (const p of batch) {
        const dk = dayKey(p.created_date);
        if (!partByDay.has(dk)) partByDay.set(dk, new Set());
        partByDay.get(dk).add(p.person_id || p.id);
      }
    }

    // --- Pass 2: leads, cursor em 'id' desc (bucket por day + partner_id) ---
    let totalLeads = 0;
    const leadsByDayPartner = new Map<string, number>(); // key: day|partnerId -> count
    let lcursor: string | null = null;
    while (true) {
      const q: any = { event_id: eventId };
      if (lcursor) q.id = { $lt: lcursor };
      const batch = await svc.entities.Lead.filter(q, '-id', BATCH);
      if (batch.length === 0) break;
      lcursor = batch[batch.length - 1].id;
      for (const l of batch) {
        totalLeads++;
        const dk = dayKey(l.created_date);
        const key = `${dk}|${l.partner_id || ""}`;
        leadsByDayPartner.set(key, (leadsByDayPartner.get(key) || 0) + 1);
      }
    }

    // --- Alvos ---
    let targetUnique = 0;
    for (const set of partByDay.values()) targetUnique += 0; // placeholder, recalc below
    // unique global = union de todos os sets
    const unionSet = new Set<string>();
    for (const set of partByDay.values()) for (const k of set) unionSet.add(k);
    targetUnique = unionSet.size;

    // --- Estado atual ---
    const existing = await svc.entities.EventStats.filter({ event_id: eventId });
    const cur = existing[0];
    const currentUnique = cur?.unique_participants_count || 0;
    const currentLeads = cur?.total_leads_count || 0;
    const drift = {
      unique: targetUnique - currentUnique,
      leads: totalLeads - currentLeads,
    };

    if (dryRun) {
      return Response.json({
        eventId,
        dryRun: true,
        current: { unique: currentUnique, leads: currentLeads },
        target: { unique: targetUnique, leads: totalLeads },
        drift,
      });
    }

    // --- Aplicar EventStats (recria limpo) ---
    if (existing.length > 0) {
      await svc.entities.EventStats.deleteMany({ event_id: eventId });
    }
    await svc.entities.EventStats.create({
      event_id: eventId,
      unique_participants_count: targetUnique,
      total_leads_count: totalLeads,
    });

    // --- Aplicar MetricBucket (recria limpo) ---
    await svc.entities.MetricBucket.deleteMany({ event_id: eventId });
    const buckets: any[] = [];
    for (const [day, set] of partByDay.entries()) {
      buckets.push({ event_id: eventId, metric_type: 'unique_participants', bucket_date: day, partner_id: '', value: set.size });
    }
    for (const [key, count] of leadsByDayPartner.entries()) {
      const [day, partnerId] = key.split('|');
      buckets.push({ event_id: eventId, metric_type: 'leads', bucket_date: day, partner_id: partnerId || '', value: count });
    }
    for (let i = 0; i < buckets.length; i += 500) {
      await svc.entities.MetricBucket.bulkCreate(buckets.slice(i, i + 500));
    }

    return Response.json({
      ok: true,
      eventId,
      applied: true,
      uniqueParticipants: targetUnique,
      totalLeads,
      bucketsCreated: buckets.length,
      previousDrift: drift,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});