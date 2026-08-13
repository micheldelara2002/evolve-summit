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
// (created_date range queries NÃO funcionam — por isso paginação por skip + bucket por dia.)
//
// --- PAGINAÇÃO POR SKIP (documentação da limitação P0.3) ---
// $lt/$gt sobre `id` NÃO são suportados pelo SDK filter (retornam 0); skip é o mecanismo
// disponível. Ordenação determinística por `id` (sort 'id'). Skip NÃO é cursor transacional:
// sem garantia de snapshot; alterações concorrentes durante o scan podem deslocar janelas
// e produzir fotografia eventualmente consistente. reconcile (esta função) é a rede de
// correção que reconstrói os buckets da fonte autoritativa, corrigindo drift do read-side.
// Memória O(BATCH): o backfill de created_day é bulkUpdate incremental por batch durante o
// scan — nunca acumula todos os registros legados (suporta milhões sem created_day).
//
// dryRun=true: reporta o que seria gravado sem aplicar.

function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

const BATCH = 500;
const GLOBAL = GLOBAL_EVENT_ID;

async function rebuildMetric(svc: any, metricType: string, entityName: string, filter: any, dryRun: boolean) {
  const dayCounts = new Map<string, number>();
  let skip = 0;
  let total = 0;
  let backfilled = 0;
  while (true) {
    const batch = await svc.entities[entityName].filter(filter, 'id', BATCH, skip);
    if (batch.length === 0) break;
    // Backfill incremental por batch — O(BATCH) memória (não acumula todos os legados).
    const batchBackfill: any[] = [];
    for (const r of batch) {
      if (!r.created_date) continue;
      const dk = dayKey(r.created_date);
      dayCounts.set(dk, (dayCounts.get(dk) || 0) + 1);
      total++;
      if (!r.created_day) batchBackfill.push({ id: r.id, created_day: dk });
    }
    if (!dryRun && batchBackfill.length > 0) {
      try { await svc.entities[entityName].bulkUpdate(batchBackfill); backfilled += batchBackfill.length; } catch {}
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