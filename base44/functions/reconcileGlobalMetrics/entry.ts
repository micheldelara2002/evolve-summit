import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { GLOBAL_EVENT_ID } from "../../shared/businessMetrics.ts";

// P0.3 — Reconstrói os buckets globais diários de users/persons/partners a partir das
// entidades autoritativas (User, Person, Partner is_deleted:false). Admin-only, bounded
// por cursor/batches (BATCH=500). Memória O(dias distintos) — não retém registros.
//
// Fonte da verdade:
//   users(day)   = count de Users criados no dia (platform-owned; append-only)
//   persons(day) = count de Persons criados no dia
//   partners(day)= count de Partners is_deleted:false criados no dia
//
// (created_date range queries NÃO funcionam — por isso paginação por cursor + bucket por dia.)
//
// dryRun=true: reporta o que seria gravado sem aplicar.

function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

const BATCH = 500;
const GLOBAL = GLOBAL_EVENT_ID;

async function rebuildMetric(svc: any, metricType: string, entityName: string, filter: any, dryRun: boolean) {
  const dayCounts = new Map<string, number>();
  const backfill: any[] = []; // P0.3 — records missing created_day (backfill para correção de borda)
  let skip = 0;
  let total = 0;
  while (true) {
    // P0.3 — skip-based pagination ($lt em `id` NÃO é suportado pelo SDK; sort 'id' determinístico)
    const batch = await svc.entities[entityName].filter(filter, 'id', BATCH, skip);
    if (batch.length === 0) break;
    for (const r of batch) {
      if (!r.created_date) continue;
      const dk = dayKey(r.created_date);
      dayCounts.set(dk, (dayCounts.get(dk) || 0) + 1);
      total++;
      if (!r.created_day) backfill.push({ id: r.id, created_day: dk });
    }
    skip += BATCH;
    if (batch.length < BATCH) break;
  }
  if (dryRun) return { metricType, total, days: dayCounts.size };

  await svc.entities.MetricBucket.deleteMany({ event_id: GLOBAL, metric_type: metricType });
  const buckets: any[] = [];
  for (const [day, count] of dayCounts.entries()) {
    buckets.push({ event_id: GLOBAL, metric_type: metricType, bucket_date: day, partner_id: "", dimension: "", value: count });
  }
  for (let i = 0; i < buckets.length; i += 500) {
    await svc.entities.MetricBucket.bulkCreate(buckets.slice(i, i + 500));
  }
  // P0.3 — backfill de created_day (best-effort; User é platform-owned mas asServiceRole bypassa RLS)
  let backfilled = 0;
  for (let i = 0; i < backfill.length; i += 500) {
    const chunk = backfill.slice(i, i + 500);
    try { await svc.entities[entityName].bulkUpdate(chunk); backfilled += chunk.length; } catch {}
  }
  return { metricType, total, days: dayCounts.size, bucketsWritten: buckets.length, backfilled };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admin only' }, { status: 403 });
    const { dryRun = false } = await req.json().catch(() => ({}));
    const svc = base44.asServiceRole;

    const users = await rebuildMetric(svc, "users", "User", {}, dryRun);
    const persons = await rebuildMetric(svc, "persons", "Person", {}, dryRun);
    const partners = await rebuildMetric(svc, "partners", "Partner", { is_deleted: false }, dryRun);

    return Response.json({ ok: true, dryRun, users, persons, partners });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});