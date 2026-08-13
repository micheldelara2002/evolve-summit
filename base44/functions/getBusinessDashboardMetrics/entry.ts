import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { GLOBAL_EVENT_ID } from "../../shared/businessMetrics.ts";

// P0.3 — Backend-driven aggregation for the Business Dashboard (read-side materializado).
//
// *** SEMÂNTICA TEMPORAL EXATA (equivalente ao algoritmo original de timestamp range) ***
// O algoritmo original filtrava registros por created_date ∈ [start, end] (precisão de timestamp).
// A plataforma NÃO suporta range queries no created_date (built-in), apenas em campos string
// custom (bucket_date, created_day). A solução preserva a semântica exata E é escalável:
//
//   Para cada KPI sobre [start, end]:
//     bulk   = soma de buckets diários para dias CHEIOS (strictly between startDay e endDay)
//              — todo registro nesses dias tem created_date ∈ [start, end]. O(1) por dia.
//     borda  = registros do dia de start e do dia de end, carregados via equality query em
//              `created_day` (campo string custom), filtrados in-memory por created_date ∈ [start, end].
//              Carga limitada a 1–2 dias de registros, independente de N total.
//     total  = bulk + borda(start) + (startDay==endDay ? 0 : borda(end))
//
// Demonstração de equivalência (período custom, start=meia-noite, end=23:59:59):
//   Para registro com created_date = D HH:MM, bucket_date = D.
//   - bulk inclui dias D com startDay < D < endDay ⟺ created_date ∈ (startDay, endDay) cheios ⊆ [start,end]. ✓
//   - borda(startDay): created_date ≥ start(00:00) ∧ ≤ end(23:59:59) ⟺ todo registro do dia startDay. ✓
//   - borda(endDay): created_date ≤ end(23:59:59) ∧ ≥ start(00:00) ⟺ todo registro do dia endDay. ✓
//   ⟹ total ≡ count(created_date ∈ [start, end]). EXATO.
//   Períodos preset (start não-meia-noite): a borda corrige registros do startDay antes de start
//   (excluídos pelo filtro in-memory) e registros do endDay depois de end. EXATO.
//
// participantsEvolution: timeseries diário (day/week/month) — permanece em buckets diários,
// coerente com a semântica do gráfico original (agregação por dia). Não é KPI pontual.
//
// DRIFT: valores de bucket são somados RAW (sem Math.max(0,...)); buckets negativos são
// evidenciados em `driftWarnings` para disparar reconcile — nunca mascarados a zero.
//
// Authorization: admin only.

// === helpers (port de src/lib/businessUtils.js) ===
function getPeriodRange(period, customStart, customEnd) {
  const now = new Date();
  const end = new Date(now);
  let start = new Date(now);
  switch (period) {
    case "7d": start.setDate(start.getDate() - 7); break;
    case "1m": start.setMonth(start.getMonth() - 1); break;
    case "3m": start.setMonth(start.getMonth() - 3); break;
    case "6m": start.setMonth(start.getMonth() - 6); break;
    case "1y": start.setFullYear(start.getFullYear() - 1); break;
    case "custom":
      // Aceita date-only (snap meia-noite / fim-do-dia, retrocompatível) OU ISO datetime (precisão de minuto).
      if (customStart) start = customStart.includes("T") ? new Date(customStart) : new Date(customStart + "T00:00:00");
      if (customEnd) end.setTime((customEnd.includes("T") ? new Date(customEnd) : new Date(customEnd + "T23:59:59")).getTime());
      break;
    default: start.setMonth(start.getMonth() - 3);
  }
  return { start, end };
}
function getPreviousRange(start, end) {
  const duration = end.getTime() - start.getTime();
  const prevEnd = new Date(start);
  const prevStart = new Date(start.getTime() - duration);
  return { start: prevStart, end: prevEnd };
}
function inRange(dateStr, start, end) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return d >= start && d <= end;
}
function pctChange(current, previous) {
  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}
function getBucketKey(dateStr, bucketType) {
  const d = new Date(dateStr);
  if (bucketType === "month") return d.toISOString().slice(0, 7);
  if (bucketType === "day") return d.toISOString().slice(0, 10);
  const tmp = new Date(d);
  const day = tmp.getDay();
  const diff = tmp.getDate() - day + (day === 0 ? -6 : 1);
  tmp.setDate(diff);
  return tmp.toISOString().slice(0, 10);
}
function formatBucketLabel(key, bucketType) {
  if (bucketType === "month") {
    const [y, m] = key.split("-");
    const names = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
    return `${names[parseInt(m) - 1]}/${y.slice(2)}`;
  }
  const [, m, d] = key.split("-");
  return `${d}/${m}`;
}
function getBucketType(days) {
  if (days <= 31) return "day";
  if (days <= 180) return "week";
  return "month";
}
function dayKeyOf(d) { return new Date(d).toISOString().slice(0, 10); }

// Lê buckets casados pela chave. `dimension` só entra no filtro quando não-vazio.
async function fetchBuckets(svc, { eventId, metricType, fromDay, toDay, partnerId, dimension }) {
  const q: any = { metric_type: metricType, bucket_date: { $gte: fromDay, $lte: toDay } };
  if (eventId) q.event_id = eventId;
  if (partnerId !== undefined) q.partner_id = partnerId;
  if (dimension) q.dimension = dimension;
  return await svc.entities.MetricBucket.filter(q, undefined, 20000);
}

// P0.3 — Paginação por cursor (sort '-id') sobre os registros do dia de borda. Para cada
// registro com created_date ∈ [start, end], chama onMatch(r). Memória O(BOUNDARY_BATCH),
// independente do total de registros no dia — substitui o limite fixo de 10.000 que
// truncava dias com >10k registros. Equivalente ao filtro created_date ∈ [start, end]
// (mesmo predicado, aplicado em batches). Acumula apenas contadores, não arrays completos.
// P0.3 — Paginação por skip (sort 'id' determinístico) sobre os registros do dia de borda.
// $lt/$gt em `id` NÃO são suportados pelo SDK (retornam 0); skip é o mecanismo disponível.
// Memória O(BOUNDARY_BATCH), independente do total do dia — substitui o limite fixo de
// 10.000 que truncava dias com >10k registros. Equivalente ao filtro created_date ∈ [start, end]
// (mesmo predicado, aplicado em batches via skip). Acumula apenas contadores, não arrays.
const BOUNDARY_BATCH = 500;
async function scanBoundary(svc, entityName, filterBase, day, start, end, onMatch) {
  const base: any = { ...filterBase, created_day: day };
  let skip = 0;
  while (true) {
    const batch = await svc.entities[entityName].filter(base, "id", BOUNDARY_BATCH, skip);
    if (!batch || batch.length === 0) break;
    for (const r of batch) {
      if (!r.created_date) continue;
      const d = new Date(r.created_date);
      if (d >= start && d <= end) onMatch(r);
    }
    skip += BOUNDARY_BATCH;
    if (batch.length < BOUNDARY_BATCH) break;
  }
}

// KPI de participantes únicos (ou por papel se profileFilter != 'all').
// bulk = buckets de dias cheios; borda = contagem paginada dos dias de start/end.
async function computeUniqueParticipants(svc, evId, profileFilter, startDay, endDay, start, end, driftWarnings) {
  const metricType = profileFilter === "all" ? "unique_participants" : "participants_by_role";
  const dimension = profileFilter === "all" ? undefined : profileFilter;
  const buckets = await fetchBuckets(svc, { eventId: evId, metricType, fromDay: startDay, toDay: endDay, dimension });
  let bulk = 0;
  for (const b of buckets) {
    const v = b.value || 0;
    if (b.bucket_date > startDay && b.bucket_date < endDay) bulk += v;
    if (v < 0) driftWarnings.push({ metric: metricType, bucket_date: b.bucket_date, partner_id: b.partner_id || "", dimension: b.dimension || "", value: v });
  }
  const filterBase: any = { is_deleted: false };
  if (evId) filterBase.event_id = evId;
  const roleFilter = profileFilter === "all" ? null : profileFilter;
  const roleMatch = (r) => !roleFilter || r.role_in_event === roleFilter;
  let startCount = 0;
  await scanBoundary(svc, "Participant", filterBase, startDay, start, end, (r) => { if (roleMatch(r)) startCount++; });
  let endCount = 0;
  if (startDay !== endDay) {
    await scanBoundary(svc, "Participant", filterBase, endDay, start, end, (r) => { if (roleMatch(r)) endCount++; });
  }
  return { count: bulk + startCount + endCount, buckets };
}

// KPI de leads + agregação por parceiro (bulk full-days + borda paginada).
async function computeLeads(svc, evId, startDay, endDay, start, end, driftWarnings) {
  const buckets = await fetchBuckets(svc, { eventId: evId, metricType: "leads", fromDay: startDay, toDay: endDay });
  let bulk = 0;
  const bulkByPartner = new Map<string, number>();
  for (const b of buckets) {
    const v = b.value || 0;
    if (b.bucket_date > startDay && b.bucket_date < endDay) {
      bulk += v;
      const pid = b.partner_id || "";
      bulkByPartner.set(pid, (bulkByPartner.get(pid) || 0) + v);
    }
    if (v < 0) driftWarnings.push({ metric: "leads", bucket_date: b.bucket_date, partner_id: b.partner_id || "", dimension: b.dimension || "", value: v });
  }
  const filterBase: any = {};
  if (evId) filterBase.event_id = evId;
  const boundaryByPartner = new Map<string, number>();
  let startCount = 0;
  const addLead = (l) => {
    startCount++;
    const pid = l.partner_id || "";
    boundaryByPartner.set(pid, (boundaryByPartner.get(pid) || 0) + 1);
  };
  await scanBoundary(svc, "Lead", filterBase, startDay, start, end, addLead);
  let endCount = 0;
  if (startDay !== endDay) {
    await scanBoundary(svc, "Lead", filterBase, endDay, start, end, (l) => {
      endCount++;
      const pid = l.partner_id || "";
      boundaryByPartner.set(pid, (boundaryByPartner.get(pid) || 0) + 1);
    });
  }
  // byPartner = bulk (full days) + boundary, agregado por partner_id
  const byPartner = new Map<string, number>();
  for (const [pid, v] of bulkByPartner) byPartner.set(pid, (byPartner.get(pid) || 0) + v);
  for (const [pid, v] of boundaryByPartner) byPartner.set(pid, (byPartner.get(pid) || 0) + v);
  return { count: bulk + startCount + endCount, buckets, byPartner };
}

// KPI global (users/persons/partners).
async function computeGlobal(svc, metricType, entityName, filterBase, startDay, endDay, start, end, driftWarnings) {
  const buckets = await fetchBuckets(svc, { eventId: GLOBAL_EVENT_ID, metricType, fromDay: startDay, toDay: endDay });
  let bulk = 0;
  for (const b of buckets) {
    const v = b.value || 0;
    if (b.bucket_date > startDay && b.bucket_date < endDay) bulk += v;
    if (v < 0) driftWarnings.push({ metric: metricType, bucket_date: b.bucket_date, partner_id: "", dimension: "", value: v });
  }
  let startCount = 0;
  await scanBoundary(svc, entityName, filterBase, startDay, start, end, () => { startCount++; });
  let endCount = 0;
  if (startDay !== endDay) {
    await scanBoundary(svc, entityName, filterBase, endDay, start, end, () => { endCount++; });
  }
  return bulk + startCount + endCount;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admin only' }, { status: 403 });

    const { period = '3m', customStart = '', customEnd = '', eventFilter = 'all', statusFilter = 'all', profileFilter = 'all' } = await req.json();

    const current = getPeriodRange(period, customStart, customEnd);
    const previous = getPreviousRange(current.start, current.end);
    const evId = eventFilter !== 'all' ? eventFilter : null;
    const svc = base44.asServiceRole;
    const driftWarnings: any[] = [];

    // Events (bounded) + EventStats (O(1)/evento).
    const [events, eventStats] = await Promise.all([
      svc.entities.Event.filter({ is_deleted: false }, '-created_date', 5000),
      svc.entities.EventStats.filter({}, undefined, 5000),
    ]);

    const validEvents = events.filter((e) => e.status === "active" || e.status === "finished");
    const statusEvents = statusFilter === "all" ? validEvents : validEvents.filter((e) => e.status === statusFilter);
    const eventScopedEvents = eventFilter === "all" ? statusEvents : statusEvents.filter((e) => e.id === eventFilter);
    const currentEvents = eventScopedEvents.filter((e) => inRange(e.start_date, current.start, current.end));
    const prevEvents = eventScopedEvents.filter((e) => inRange(e.start_date, previous.start, previous.end));

    const activeNow = currentEvents.filter((e) => e.status === "active").length;
    const activePrev = prevEvents.filter((e) => e.status === "active").length;
    const finishedNow = currentEvents.filter((e) => e.status === "finished").length;
    const finishedPrev = prevEvents.filter((e) => e.status === "finished").length;

    // === Dias de borda (reais, não snapped) ===
    const curStartDay = dayKeyOf(current.start);
    const curEndDay = dayKeyOf(current.end);
    const prevStartDay = dayKeyOf(previous.start);
    const prevEndDay = dayKeyOf(previous.end);

    // === Globais (users/persons/partners) — bulk + correção de borda (corrente E anterior) ===
    const [usersNow, usersPrev, personsNow, personsPrev, partnersNow, partnersPrev] = await Promise.all([
      computeGlobal(svc, "users", "User", {}, curStartDay, curEndDay, current.start, current.end, driftWarnings),
      computeGlobal(svc, "users", "User", {}, prevStartDay, prevEndDay, previous.start, previous.end, driftWarnings),
      computeGlobal(svc, "persons", "Person", {}, curStartDay, curEndDay, current.start, current.end, driftWarnings),
      computeGlobal(svc, "persons", "Person", {}, prevStartDay, prevEndDay, previous.start, previous.end, driftWarnings),
      computeGlobal(svc, "partners", "Partner", { is_deleted: false }, curStartDay, curEndDay, current.start, current.end, driftWarnings),
      computeGlobal(svc, "partners", "Partner", { is_deleted: false }, prevStartDay, prevEndDay, previous.start, previous.end, driftWarnings),
    ]);

    // === uniqueParticipants (corrente + anterior) + evolution ===
    const [curUniq, prevUniq] = await Promise.all([
      computeUniqueParticipants(svc, evId, profileFilter, curStartDay, curEndDay, current.start, current.end, driftWarnings),
      computeUniqueParticipants(svc, evId, profileFilter, prevStartDay, prevEndDay, previous.start, previous.end, driftWarnings),
    ]);
    const uniqNow = curUniq.count;
    const uniqPrev = prevUniq.count;

    // participantsEvolution (timeseries diário — dia/semana/mês; borda inclusa como dia cheio, coerente com gráfico)
    const days = (current.end.getTime() - new Date(curStartDay + "T00:00:00").getTime()) / (1000 * 60 * 60 * 24);
    const bucketType = getBucketType(days);
    const displayMap = new Map<string, number>();
    for (const b of curUniq.buckets) {
      const displayKey = getBucketKey(b.bucket_date + "T12:00:00", bucketType);
      displayMap.set(displayKey, (displayMap.get(displayKey) || 0) + (b.value || 0));
    }
    const participantsEvolution = Array.from(displayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => ({ date: formatBucketLabel(key, bucketType), count }));

    // === leads (corrente + anterior) + byPartner ===
    const [curLeads, prevLeads] = await Promise.all([
      computeLeads(svc, evId, curStartDay, curEndDay, current.start, current.end, driftWarnings),
      computeLeads(svc, evId, prevStartDay, prevEndDay, previous.start, previous.end, driftWarnings),
    ]);
    const leadsNow = curLeads.count;
    const leadsPrev = prevLeads.count;

    // LeadsByPartner: bulk (full days) + boundary, já agregado por partner_id em computeLeads
    const topPartners = Array.from((curLeads.byPartner || new Map()).entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const topPartnerIds = topPartners.map(([pid]) => pid).filter(Boolean);
    const partnerNameMap = new Map<string, string>();
    if (topPartnerIds.length > 0) {
      const fetched = await svc.entities.Partner.filter({ id: { $in: topPartnerIds } }, undefined, 50);
      for (const p of fetched) partnerNameMap.set(p.id, p.trade_name || p.legal_name || "Sem nome");
    }
    const leadsByPartner = topPartners.map(([pid, leads]) => ({
      name: pid ? (partnerNameMap.get(pid) || "Sem parceiro") : "Sem parceiro",
      leads,
    }));

    // === Events status ===
    const eventsStatus = [
      { name: "Ativos", value: activeNow },
      { name: "Encerrados", value: finishedNow },
    ];

    // === Top events (all-time) via EventStats (soma todas as linhas por evento) ===
    const statsByEvent = new Map<string, any>();
    for (const s of eventStats) {
      const cur = statsByEvent.get(s.event_id) || { unique_participants_count: 0, total_leads_count: 0 };
      cur.unique_participants_count += s.unique_participants_count || 0;
      cur.total_leads_count += s.total_leads_count || 0;
      statsByEvent.set(s.event_id, cur);
    }
    const topEvents = eventScopedEvents
      .map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        uniqueParticipants: statsByEvent.get(e.id)?.unique_participants_count || 0,
        leads: statsByEvent.get(e.id)?.total_leads_count || 0,
      }))
      .sort((a, b) => b.uniqueParticipants - a.uniqueParticipants)
      .slice(0, 10);

    const trimmedEvents = events.map((e) => ({
      id: e.id, name: e.name, status: e.status, start_date: e.start_date,
    }));

    return Response.json({
      kpis: {
        users: { count: usersNow, delta: pctChange(usersNow, usersPrev) },
        persons: { count: personsNow, delta: pctChange(personsNow, personsPrev) },
        eventsActive: { count: activeNow, delta: pctChange(activeNow, activePrev) },
        eventsFinished: { count: finishedNow, delta: pctChange(finishedNow, finishedPrev) },
        partners: { count: partnersNow, delta: pctChange(partnersNow, partnersPrev) },
        uniqueParticipants: { count: uniqNow, delta: pctChange(uniqNow, uniqPrev) },
        leads: { count: leadsNow, delta: pctChange(leadsNow, leadsPrev) },
      },
      participantsEvolution,
      leadsByPartner,
      eventsStatus,
      topEvents,
      events: trimmedEvents,
      driftWarnings,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});