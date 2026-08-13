// P0.3 — Business Dashboard materialization helpers.
//
// EventStats = estado ATUAL por evento (unique_participants_count, total_leads_count).
// MetricBucket = série temporal diária (unique_participants por evento; leads por evento+partner_id).
//
// Regras de integridade (preservam a semântica do dashboard):
//   Participant.create       → EventStats.unique++  AND MetricBucket(unique_participants, day=created)++
//   Participant.soft-delete  → EventStats.unique--  AND MetricBucket(unique_participants, day=created)--
//     (dashboard filtra is_deleted:false ANTES de contar; o registro deletado sai do counter atual
//      E do bucket histórico, usando a data ORIGINAL de criação — nunca a data do delete.)
//   Lead.create              → EventStats.leads++   AND MetricBucket(leads, day=created, partner_id)++
//     (leads são append-only; sem delete no app.)
//
// Race handling: leituras SOMAM todos os buckets/EventStats casados pela chave, então duplicatas
// eventuais não corrompem o total. reconcile consolida.

function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export async function ensureEventStats(svc: any, eventId: string): Promise<any> {
  const existing = await svc.entities.EventStats.filter({ event_id: eventId });
  if (existing.length > 0) return existing[0];
  try {
    return await svc.entities.EventStats.create({
      event_id: eventId,
      unique_participants_count: 0,
      total_leads_count: 0,
    });
  } catch {
    const retry = await svc.entities.EventStats.filter({ event_id: eventId });
    return retry[0];
  }
}

async function touchBucket(
  svc: any,
  opts: { eventId: string; metricType: string; bucketDate: string; partnerId?: string; delta: number }
): Promise<void> {
  const filter: any = { event_id: opts.eventId, metric_type: opts.metricType, bucket_date: opts.bucketDate, partner_id: opts.partnerId || "" };
  const existing = await svc.entities.MetricBucket.filter(filter);
  if (existing.length > 0) {
    await svc.entities.MetricBucket.updateMany({ id: existing[0].id }, { $inc: { value: opts.delta } });
    return;
  }
  if (opts.delta < 0) return; // não há bucket para decrementar; reconcile corrige
  try {
    await svc.entities.MetricBucket.create({ ...filter, value: opts.delta });
  } catch {
    const retry = await svc.entities.MetricBucket.filter(filter);
    if (retry[0]) await svc.entities.MetricBucket.updateMany({ id: retry[0].id }, { $inc: { value: opts.delta } });
  }
}

export async function incUniqueParticipant(svc: any, eventId: string, createdDateISO: string): Promise<void> {
  if (!eventId || !createdDateISO) return;
  const stats = await ensureEventStats(svc, eventId);
  if (stats) await svc.entities.EventStats.updateMany({ id: stats.id }, { $inc: { unique_participants_count: 1 } });
  await touchBucket(svc, { eventId, metricType: "unique_participants", bucketDate: dayKey(createdDateISO), delta: 1 });
}

export async function decUniqueParticipant(svc: any, eventId: string, createdDateISO: string): Promise<void> {
  if (!eventId || !createdDateISO) return;
  const stats = await svc.entities.EventStats.filter({ event_id: eventId });
  if (stats[0]) await svc.entities.EventStats.updateMany({ id: stats[0].id }, { $inc: { unique_participants_count: -1 } });
  await touchBucket(svc, { eventId, metricType: "unique_participants", bucketDate: dayKey(createdDateISO), delta: -1 });
}

export async function incLeads(svc: any, eventId: string, partnerId: string, createdDateISO: string, count = 1): Promise<void> {
  if (!eventId || !createdDateISO) return;
  const stats = await ensureEventStats(svc, eventId);
  if (stats) await svc.entities.EventStats.updateMany({ id: stats.id }, { $inc: { total_leads_count: count } });
  await touchBucket(svc, { eventId, metricType: "leads", bucketDate: dayKey(createdDateISO), partnerId: partnerId || "", delta: count });
}