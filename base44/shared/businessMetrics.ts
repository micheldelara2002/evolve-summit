// P0.3 — Business Dashboard materialization helpers.
//
// EventStats = estado ATUAL por evento (unique_participants_count, total_leads_count).
// MetricBucket = série temporal diária:
//   unique_participants (por evento)
//   participants_by_role (por evento + dimension=role_in_event)
//   leads (por evento + partner_id)
//   users / persons / partners (globais — event_id='__global__')
//
// INVARIANTE DE NEGÓCIO (documentada): uma Person aparece no MÁXIMO uma vez como
// Participant(is_deleted:false) por evento. Logo:
//   unique_participants(evento) = count de Participant(is_deleted:false)
//   participants_by_role(evento,role,day) = count de Participant(is_deleted:false, role, day)
// Não é necessário Set de dedup global — reconcile usa contagem direta (memória O(dias×papéis)).
// Violação da invariante (pessoa duplicada no mesmo evento) => overcount; ver risco residual no reconcile.
//
// Regras de integridade (preservam a semântica do dashboard):
//   Participant.create(role=R)        → EventStats.unique++ AND unique_participants(day=created)++
//                                      AND participants_by_role(day=created, role=R)++
//   Participant.soft-delete(role=R)   → EventStats.unique-- AND unique_participants(day=created)--
//                                      AND participants_by_role(day=created, role=R)--
//   Participant.role_change(R1→R2)    → participants_by_role(day=created, role=R1)-- AND (role=R2)++
//                                      (unique NÃO muda — mesma pessoa)
//   Lead.create(partner)              → EventStats.leads++ AND leads(day=created, partner_id)++
//   Partner.create                    → partners(day=created)++
//   Partner.soft-delete               → partners(day=created)--  (is_deleted:false no dashboard)
//   Person.create                     → persons(day=created)++
//   User.signup                       → users(day=created)++   (via workflow app_user_auth:signup)
//
// Concorrência (MetricBucket): NÃO existe UNIQUE constraint em (event_id,metric_type,bucket_date,
//   partner_id,dimension). touchBucket faz filter→update $inc (atômico) ou create. Dois creates
//   concorrentes para a mesma chave produzem DUAS linhas (sem constraint que bloqueie). Leituras
//   SOMAM todas as linhas casadas pela chave, então duplicatas NÃO corrompem o total — apenas
//   geram leve storage bloat, consolidado por reconcile. $inc é atômico a nível de documento.

export const GLOBAL_EVENT_ID = "__global__";

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

// toca um bucket atômicamente. `dimension` só entra no filtro/create quando não-vazio
// (preserva match com buckets legados de unique_participants/leads que não têm o campo).
async function touchBucket(
  svc: any,
  opts: { eventId: string; metricType: string; bucketDate: string; partnerId?: string; dimension?: string; delta: number }
): Promise<void> {
  const filter: any = { event_id: opts.eventId, metric_type: opts.metricType, bucket_date: opts.bucketDate, partner_id: opts.partnerId || "" };
  if (opts.dimension) filter.dimension = opts.dimension;
  const existing = await svc.entities.MetricBucket.filter(filter);
  if (existing.length > 0) {
    // $inc atômico no primeiro casado. Duplicatas concorrentes permanecem e são somadas na leitura.
    await svc.entities.MetricBucket.updateMany({ id: existing[0].id }, { $inc: { value: opts.delta } });
    return;
  }
  if (opts.delta < 0) return; // bucket inexistente para decrementar — drift visível na leitura; reconcile corrige
  try {
    await svc.entities.MetricBucket.create({ ...filter, value: opts.delta });
  } catch {
    // race: outra requisição criou a mesma chave entre nosso filter e create.
    const retry = await svc.entities.MetricBucket.filter(filter);
    if (retry[0]) await svc.entities.MetricBucket.updateMany({ id: retry[0].id }, { $inc: { value: opts.delta } });
  }
}

// === unique_participants (por evento) ===
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

// === participants_by_role (por evento + role) — depende da invariante de unicidade ===
export async function incParticipantsByRole(svc: any, eventId: string, role: string, createdDateISO: string): Promise<void> {
  if (!eventId || !role || !createdDateISO) return;
  await touchBucket(svc, { eventId, metricType: "participants_by_role", bucketDate: dayKey(createdDateISO), dimension: role, delta: 1 });
}

export async function decParticipantsByRole(svc: any, eventId: string, role: string, createdDateISO: string): Promise<void> {
  if (!eventId || !role || !createdDateISO) return;
  await touchBucket(svc, { eventId, metricType: "participants_by_role", bucketDate: dayKey(createdDateISO), dimension: role, delta: -1 });
}

export async function moveParticipantsByRole(svc: any, eventId: string, oldRole: string, newRole: string, createdDateISO: string): Promise<void> {
  if (oldRole === newRole) return;
  if (oldRole) await decParticipantsByRole(svc, eventId, oldRole, createdDateISO);
  if (newRole) await incParticipantsByRole(svc, eventId, newRole, createdDateISO);
}

// === leads (por evento + partner_id) ===
export async function incLeads(svc: any, eventId: string, partnerId: string, createdDateISO: string, count = 1): Promise<void> {
  if (!eventId || !createdDateISO) return;
  const stats = await ensureEventStats(svc, eventId);
  if (stats) await svc.entities.EventStats.updateMany({ id: stats.id }, { $inc: { total_leads_count: count } });
  await touchBucket(svc, { eventId, metricType: "leads", bucketDate: dayKey(createdDateISO), partnerId: partnerId || "", delta: count });
}

// === globais (users/persons/partners) ===
async function touchGlobal(svc: any, metricType: string, createdDateISO: string, delta: number): Promise<void> {
  if (!createdDateISO) return;
  await touchBucket(svc, { eventId: GLOBAL_EVENT_ID, metricType, bucketDate: dayKey(createdDateISO), delta });
}

export const incUsers = (svc: any, createdDateISO: string) => touchGlobal(svc, "users", createdDateISO, 1);
export const incPersons = (svc: any, createdDateISO: string) => touchGlobal(svc, "persons", createdDateISO, 1);
export const incPartners = (svc: any, createdDateISO: string) => touchGlobal(svc, "partners", createdDateISO, 1);
export const decPartners = (svc: any, createdDateISO: string) => touchGlobal(svc, "partners", createdDateISO, -1);