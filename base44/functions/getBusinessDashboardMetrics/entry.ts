import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// P0.3 — Backend-driven aggregation for the Business Dashboard (read-side materializado).
//
// IMPORTANTE — limitação da plataforma: queries de range em `created_date` (built-in) NÃO
// funcionam (retornam 0). Apenas range queries em campos string (ex.: bucket_date) funcionam.
// Por isso a leitura NÃO usa created_date range:
//   - EventStats  → TopEvents (all-time unique_participants_count, total_leads_count) — O(1)/evento
//   - MetricBucket(unique_participants, daily) → uniqNow/Prev + ParticipantsEvolution
//   - MetricBucket(leads, daily, partner_id) → leads Now/Prev + LeadsByPartner
//   - Periodos bucket-based são alinhados ao início do dia (snap to midnight): garante exatidão
//     sem precisar de trim via created_date. Delta Now/Prev permanece período-a-período.
//   - profileFilter != 'all' → fallback in-memory (load por evento, role + inRange)
//   - Users/Persons/Partners → load all (cap 5000) + in-memory inRange (corrige KPIs que
//     antes retornavam 0 pela query de range quebrada)
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

// Soma buckets de uma métrica em [fromDay, toDay] (strings YYYY-MM-DD).
async function sumBuckets(svc, { eventId, metricType, fromDay, toDay, partnerId }) {
  const q: any = { metric_type: metricType, bucket_date: { $gte: fromDay, $lte: toDay } };
  if (eventId) q.event_id = eventId;
  if (partnerId !== undefined) q.partner_id = partnerId;
  const buckets = await svc.entities.MetricBucket.filter(q, undefined, 20000);
  return buckets;
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

    const [events, partners, users, persons, eventStats] = await Promise.all([
      svc.entities.Event.filter({ is_deleted: false }, '-created_date', 5000),
      svc.entities.Partner.filter({ is_deleted: false }, '-created_date', 5000),
      svc.entities.User.list('-created_date', 5000),
      svc.entities.Person.list('-created_date', 5000),
      svc.entities.EventStats.filter({}, undefined, 5000),
    ]);

    // === Events: exclui draft e cancelled ===
    const validEvents = events.filter((e) => e.status === "active" || e.status === "finished");
    const statusEvents = statusFilter === "all" ? validEvents : validEvents.filter((e) => e.status === statusFilter);
    const eventScopedEvents = eventFilter === "all" ? statusEvents : statusEvents.filter((e) => e.id === eventFilter);
    const currentEvents = eventScopedEvents.filter((e) => inRange(e.start_date, current.start, current.end));
    const prevEvents = eventScopedEvents.filter((e) => inRange(e.start_date, previous.start, previous.end));

    const activeNow = currentEvents.filter((e) => e.status === "active").length;
    const activePrev = prevEvents.filter((e) => e.status === "active").length;
    const finishedNow = currentEvents.filter((e) => e.status === "finished").length;
    const finishedPrev = prevEvents.filter((e) => e.status === "finished").length;

    // === Users / Persons / Partners — in-memory inRange (created_date range query quebrada) ===
    const usersNow = users.filter((u) => inRange(u.created_date, current.start, current.end)).length;
    const usersPrev = users.filter((u) => inRange(u.created_date, previous.start, previous.end)).length;
    const personsNow = persons.filter((p) => inRange(p.created_date, current.start, current.end)).length;
    const personsPrev = persons.filter((p) => inRange(p.created_date, previous.start, previous.end)).length;
    const partnersNow = partners.filter((p) => inRange(p.created_date, current.start, current.end)).length;
    const partnersPrev = partners.filter((p) => inRange(p.created_date, previous.start, previous.end)).length;

    // === Periodos bucket-based alinhados ao dia (snap to midnight) ===
    const curSnapStart = snapToMidnight(current.start);
    const curFromDay = dayKeyOf(curSnapStart);
    const curToDay = dayKeyOf(current.end);
    const prevSnapStart = snapToMidnight(previous.start);
    const prevToDay = dayKeyOf(new Date(curSnapStart.getTime() - 1)); // dia anterior ao current start

    let uniqNow, uniqPrev, participantsEvolution, leadsNow, leadsPrev, leadsByPartner;

    if (profileFilter === "all") {
      // uniqNow/Prev via MetricBucket(unique_participants)
      const [curBuckets, prevBuckets] = await Promise.all([
        sumBuckets(svc, { eventId: evId, metricType: "unique_participants", fromDay: curFromDay, toDay: curToDay, partnerId: "" }),
        sumBuckets(svc, { eventId: evId, metricType: "unique_participants", fromDay: dayKeyOf(prevSnapStart), toDay: prevToDay, partnerId: "" }),
      ]);
      uniqNow = curBuckets.reduce((s, b) => s + Math.max(0, b.value || 0), 0);
      uniqPrev = prevBuckets.reduce((s, b) => s + Math.max(0, b.value || 0), 0);

      // Evolution: agrega buckets diários em display buckets
      const days = (current.end.getTime() - curSnapStart.getTime()) / (1000 * 60 * 60 * 24);
      const bucketType = getBucketType(days);
      const displayMap = new Map<string, number>();
      for (const b of curBuckets) {
        const displayKey = getBucketKey(b.bucket_date + "T12:00:00", bucketType);
        displayMap.set(displayKey, (displayMap.get(displayKey) || 0) + Math.max(0, b.value || 0));
      }
      participantsEvolution = Array.from(displayMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, count]) => ({ date: formatBucketLabel(key, bucketType), count }));

      // Leads Now/Prev + ByPartner via MetricBucket(leads, partner_id)
      const [curLeadsBuckets, prevLeadsBuckets] = await Promise.all([
        sumBuckets(svc, { eventId: evId, metricType: "leads", fromDay: curFromDay, toDay: curToDay }),
        sumBuckets(svc, { eventId: evId, metricType: "leads", fromDay: dayKeyOf(prevSnapStart), toDay: prevToDay }),
      ]);
      leadsNow = curLeadsBuckets.reduce((s, b) => s + Math.max(0, b.value || 0), 0);
      leadsPrev = prevLeadsBuckets.reduce((s, b) => s + Math.max(0, b.value || 0), 0);

      const partnerMap = new Map(partners.map((p) => [p.id, p.trade_name || p.legal_name || "Sem nome"]));
      const lbpMap = new Map();
      for (const b of curLeadsBuckets) {
        const name = partnerMap.get(b.partner_id) || "Sem parceiro";
        lbpMap.set(name, (lbpMap.get(name) || 0) + Math.max(0, b.value || 0));
      }
      leadsByPartner = Array.from(lbpMap.entries())
        .map(([name, count]) => ({ name, leads: count }))
        .sort((a, b) => b.leads - a.leads)
        .slice(0, 10);
    } else {
      // Fallback profileFilter: load participantes (por evento ou all), in-memory role + inRange
      const partQ: any = { is_deleted: false };
      if (evId) partQ.event_id = evId;
      const parts = await svc.entities.Participant.filter(partQ, "-created_date", 10000);
      const curParts = parts.filter((p) => p.role_in_event === profileFilter && inRange(p.created_date, current.start, current.end));
      const prevParts = parts.filter((p) => p.role_in_event === profileFilter && inRange(p.created_date, previous.start, previous.end));
      const curSet = new Set(); curParts.forEach((p) => curSet.add(`${p.event_id}:${p.person_id || p.id}`));
      const prevSet = new Set(); prevParts.forEach((p) => prevSet.add(`${p.event_id}:${p.person_id || p.id}`));
      uniqNow = curSet.size; uniqPrev = prevSet.size;

      const days = (current.end.getTime() - current.start.getTime()) / (1000 * 60 * 60 * 24);
      const bucketType = getBucketType(days);
      const bMap = new Map<string, Set<string>>();
      curParts.forEach((p) => {
        const key = getBucketKey(p.created_date, bucketType);
        if (!bMap.has(key)) bMap.set(key, new Set());
        bMap.get(key).add(`${p.event_id}:${p.person_id || p.id}`);
      });
      participantsEvolution = Array.from(bMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, set]) => ({ date: formatBucketLabel(key, bucketType), count: set.size }));

      // Leads (sem dimensão profile) via buckets
      const [curLeadsBuckets, prevLeadsBuckets] = await Promise.all([
        sumBuckets(svc, { eventId: evId, metricType: "leads", fromDay: curFromDay, toDay: curToDay }),
        sumBuckets(svc, { eventId: evId, metricType: "leads", fromDay: dayKeyOf(prevSnapStart), toDay: prevToDay }),
      ]);
      leadsNow = curLeadsBuckets.reduce((s, b) => s + Math.max(0, b.value || 0), 0);
      leadsPrev = prevLeadsBuckets.reduce((s, b) => s + Math.max(0, b.value || 0), 0);
      const partnerMap = new Map(partners.map((p) => [p.id, p.trade_name || p.legal_name || "Sem nome"]));
      const lbpMap = new Map();
      for (const b of curLeadsBuckets) {
        const name = partnerMap.get(b.partner_id) || "Sem parceiro";
        lbpMap.set(name, (lbpMap.get(name) || 0) + Math.max(0, b.value || 0));
      }
      leadsByPartner = Array.from(lbpMap.entries())
        .map(([name, count]) => ({ name, leads: count }))
        .sort((a, b) => b.leads - a.leads)
        .slice(0, 10);
    }

    // === Events status ===
    const eventsStatus = [
      { name: "Ativos", value: activeNow },
      { name: "Encerrados", value: finishedNow },
    ];

    // === Top events (all-time) via EventStats ===
    const statsByEvent = new Map(eventStats.map((s) => [s.event_id, s]));
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

    // === Trimmed events for by-month chart + dropdown ===
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
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});