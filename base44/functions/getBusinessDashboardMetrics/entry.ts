import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { GLOBAL_EVENT_ID } from "../../shared/businessMetrics.ts";

// P0.3 — Backend-driven aggregation for the Business Dashboard (read-side materializado).
//
// IMPORTANTE — limitação da plataforma: queries de range em `created_date` (built-in) NÃO
// funcionam (retornam 0). Apenas range queries em campos string (bucket_date) funcionam.
// Leitura NÃO carrega a base global (User/Person/Partner) — lê MetricBucket:
//   - EventStats                → TopEvents (all-time unique_participants_count, total_leads_count) — O(1)/evento
//   - MetricBucket(unique_participants, daily)        → uniqNow/Prev + ParticipantsEvolution (profileFilter=all)
//   - MetricBucket(participants_by_role, daily, dimension=role) → uniqNow/Prev + Evolution (profileFilter!=all)
//   - MetricBucket(leads, daily, partner_id)          → leads Now/Prev + LeadsByPartner
//   - MetricBucket(users/persons/partners, __global__)→ usersNow/Prev, personsNow/Prev, partnersNow/Prev
//   - Periodos bucket-based alinhados ao início do dia (snap to midnight).
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
      if (customStart) start = new Date(customStart + "T00:00:00");
      if (customEnd) end.setTime(new Date(customEnd + "T23:59:59").getTime());
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
  if (bucketType === "day") return d.toISOString().slice(0, 10);
  if (bucketType === "month") return d.toISOString().slice(0, 7);
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
function dayKeyOf(d: Date): string { return d.toISOString().slice(0, 10); }
function snapToMidnight(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

// Lê buckets casados pela chave. `dimension` só entra no filtro quando não-vazio.
async function fetchBuckets(svc, { eventId, metricType, fromDay, toDay, partnerId, dimension }) {
  const q: any = { metric_type: metricType, bucket_date: { $gte: fromDay, $lte: toDay } };
  if (eventId) q.event_id = eventId;
  if (partnerId !== undefined) q.partner_id = partnerId;
  if (dimension) q.dimension = dimension;
  return await svc.entities.MetricBucket.filter(q, undefined, 20000);
}

// Soma RAW (sem clamp); coleta buckets negativos como evidência de drift.
function sumRaw(buckets, warnings, metricLabel) {
  let s = 0;
  for (const b of buckets) {
    const v = (b.value === null || b.value === undefined) ? 0 : b.value;
    s += v;
    if (v < 0) warnings.push({ metric: metricLabel, bucket_date: b.bucket_date, partner_id: b.partner_id || "", dimension: b.dimension || "", value: v });
  }
  return s;
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

    // Events (bounded — dezenas/centenas) + EventStats (O(1)/evento). Sem User/Person/Partner globais.
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

    // === Periodos bucket-based alinhados ao dia (snap to midnight) ===
    const curSnapStart = snapToMidnight(current.start);
    const curFromDay = dayKeyOf(curSnapStart);
    const curToDay = dayKeyOf(current.end);
    const prevSnapStart = snapToMidnight(previous.start);
    const prevFromDay = dayKeyOf(prevSnapStart);
    const prevToDay = dayKeyOf(new Date(curSnapStart.getTime() - 1));

    // === Globais (users/persons/partners) — MetricBucket __global__ ===
    const [usersCur, usersPrev, personsCur, personsPrev, partnersCur, partnersPrev] = await Promise.all([
      fetchBuckets(svc, { eventId: GLOBAL_EVENT_ID, metricType: "users", fromDay: curFromDay, toDay: curToDay }),
      fetchBuckets(svc, { eventId: GLOBAL_EVENT_ID, metricType: "users", fromDay: prevFromDay, toDay: prevToDay }),
      fetchBuckets(svc, { eventId: GLOBAL_EVENT_ID, metricType: "persons", fromDay: curFromDay, toDay: curToDay }),
      fetchBuckets(svc, { eventId: GLOBAL_EVENT_ID, metricType: "persons", fromDay: prevFromDay, toDay: prevToDay }),
      fetchBuckets(svc, { eventId: GLOBAL_EVENT_ID, metricType: "partners", fromDay: curFromDay, toDay: curToDay }),
      fetchBuckets(svc, { eventId: GLOBAL_EVENT_ID, metricType: "partners", fromDay: prevFromDay, toDay: prevToDay }),
    ]);
    const usersNow = sumRaw(usersCur, driftWarnings, "users");
    const usersPrevSum = sumRaw(usersPrev, driftWarnings, "users");
    const personsNow = sumRaw(personsCur, driftWarnings, "persons");
    const personsPrevSum = sumRaw(personsPrev, driftWarnings, "persons");
    const partnersNow = sumRaw(partnersCur, driftWarnings, "partners");
    const partnersPrevSum = sumRaw(partnersPrev, driftWarnings, "partners");

    let uniqNow, uniqPrev, participantsEvolution, leadsNow, leadsPrev, leadsByPartner;

    if (profileFilter === "all") {
      // uniqNow/Prev via MetricBucket(unique_participants)
      const [curBuckets, prevBuckets] = await Promise.all([
        fetchBuckets(svc, { eventId: evId, metricType: "unique_participants", fromDay: curFromDay, toDay: curToDay, partnerId: "" }),
        fetchBuckets(svc, { eventId: evId, metricType: "unique_participants", fromDay: prevFromDay, toDay: prevToDay, partnerId: "" }),
      ]);
      uniqNow = sumRaw(curBuckets, driftWarnings, "unique_participants");
      uniqPrev = sumRaw(prevBuckets, driftWarnings, "unique_participants");

      const days = (current.end.getTime() - curSnapStart.getTime()) / (1000 * 60 * 60 * 24);
      const bucketType = getBucketType(days);
      const displayMap = new Map<string, number>();
      for (const b of curBuckets) {
        const displayKey = getBucketKey(b.bucket_date + "T12:00:00", bucketType);
        const v = b.value || 0;
        displayMap.set(displayKey, (displayMap.get(displayKey) || 0) + v);
      }
      participantsEvolution = Array.from(displayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, count]) => ({ date: formatBucketLabel(key, bucketType), count }));
    } else {
      // profileFilter via MetricBucket(participants_by_role, dimension=role) — escalável, sem load de Participants
      const [curBuckets, prevBuckets] = await Promise.all([
        fetchBuckets(svc, { eventId: evId, metricType: "participants_by_role", fromDay: curFromDay, toDay: curToDay, dimension: profileFilter }),
        fetchBuckets(svc, { eventId: evId, metricType: "participants_by_role", fromDay: prevFromDay, toDay: prevToDay, dimension: profileFilter }),
      ]);
      uniqNow = sumRaw(curBuckets, driftWarnings, "participants_by_role");
      uniqPrev = sumRaw(prevBuckets, driftWarnings, "participants_by_role");

      const days = (current.end.getTime() - curSnapStart.getTime()) / (1000 * 60 * 60 * 24);
      const bucketType = getBucketType(days);
      const displayMap = new Map<string, number>();
      for (const b of curBuckets) {
        const displayKey = getBucketKey(b.bucket_date + "T12:00:00", bucketType);
        const v = b.value || 0;
        displayMap.set(displayKey, (displayMap.get(displayKey) || 0) + v);
      }
      participantsEvolution = Array.from(displayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, count]) => ({ date: formatBucketLabel(key, bucketType), count }));
    }

    // Leads Now/Prev + ByPartner via MetricBucket(leads, partner_id)
    const [curLeadsBuckets, prevLeadsBuckets] = await Promise.all([
      fetchBuckets(svc, { eventId: evId, metricType: "leads", fromDay: curFromDay, toDay: curToDay }),
      fetchBuckets(svc, { eventId: evId, metricType: "leads", fromDay: prevFromDay, toDay: prevToDay }),
    ]);
    leadsNow = sumRaw(curLeadsBuckets, driftWarnings, "leads");
    leadsPrev = sumRaw(prevLeadsBuckets, driftWarnings, "leads");

    // LeadsByPartner: agrega por partner_id, top 10, resolve nomes on-demand (não carrega Partner global)
    const lbpMap = new Map<string, number>();
    for (const b of curLeadsBuckets) {
      const pid = b.partner_id || "";
      lbpMap.set(pid, (lbpMap.get(pid) || 0) + (b.value || 0));
    }
    const topPartners = Array.from(lbpMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const topPartnerIds = topPartners.map(([pid]) => pid).filter(Boolean);
    const partnerNameMap = new Map<string, string>();
    if (topPartnerIds.length > 0) {
      const fetched = await svc.entities.Partner.filter({ id: { $in: topPartnerIds } }, undefined, 50);
      for (const p of fetched) partnerNameMap.set(p.id, p.trade_name || p.legal_name || "Sem nome");
    }
    leadsByPartner = topPartners.map(([pid, leads]) => ({
      name: pid ? (partnerNameMap.get(pid) || "Sem parceiro") : "Sem parceiro",
      leads,
    }));

    // === Events status ===
    const eventsStatus = [
      { name: "Ativos", value: activeNow },
      { name: "Encerrados", value: finishedNow },
    ];

    // === Top events (all-time) via EventStats ===
    // Soma todas as linhas de EventStats por evento (pode haver duplicatas por race concorrente
    // em ensureEventStats; reconcile consolida). Mesmo padrão "soma todos os casados" do MetricBucket.
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
        users: { count: usersNow, delta: pctChange(usersNow, usersPrevSum) },
        persons: { count: personsNow, delta: pctChange(personsNow, personsPrevSum) },
        eventsActive: { count: activeNow, delta: pctChange(activeNow, activePrev) },
        eventsFinished: { count: finishedNow, delta: pctChange(finishedNow, finishedPrev) },
        partners: { count: partnersNow, delta: pctChange(partnersNow, partnersPrevSum) },
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