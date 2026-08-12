import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// P0.3 — Backend-driven aggregation for the Business Dashboard.
//
// Replaces the previous pattern of loading 6 entities (users, persons, events,
// partners, participants, leads) at FETCH_LIMIT=10000 each to the client and
// aggregating via Array.reduce in a useMemo. This function runs filtered,
// date-bounded queries server-side and returns only the final metrics — no
// 10k-record transfer to the client, no client-side Array.reduce.
//
// Authorization: admin only (BusinessDashboard is behind AdminRoute).

// === Port of src/lib/businessUtils.js ===

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
  // week: compute Monday
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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admin only' }, { status: 403 });

    const { period = '3m', customStart = '', customEnd = '', eventFilter = 'all', statusFilter = 'all', profileFilter = 'all' } = await req.json();

    // Period ranges
    const current = getPeriodRange(period, customStart, customEnd);
    const previous = getPreviousRange(current.start, current.end);
    const combinedStartISO = previous.start.toISOString();
    const currentEndISO = current.end.toISOString();

    // P0.3: Parallel queries.
    // Events + Partners: all records (small datasets, needed for by-month chart, dropdown, name mapping).
    // Users + Persons: date-bounded (only used for KPI counts — smaller working set).
    // Participants + Leads: event/profile-filtered (needed for both period KPIs and all-time topEvents).
    const [events, partners, users, persons, participants, leads] = await Promise.all([
      base44.asServiceRole.entities.Event.filter({ is_deleted: false }, '-created_date', 5000),
      base44.asServiceRole.entities.Partner.filter({ is_deleted: false }, '-created_date', 5000),
      base44.asServiceRole.entities.User.filter({ created_date: { $gte: combinedStartISO, $lte: currentEndISO } }, '-created_date', 5000),
      base44.asServiceRole.entities.Person.filter({ created_date: { $gte: combinedStartISO, $lte: currentEndISO } }, '-created_date', 5000),
      base44.asServiceRole.entities.Participant.filter({
        is_deleted: false,
        ...(eventFilter !== 'all' ? { event_id: eventFilter } : {}),
        ...(profileFilter !== 'all' ? { role_in_event: profileFilter } : {}),
      }, '-created_date', 10000),
      base44.asServiceRole.entities.Lead.filter({
        ...(eventFilter !== 'all' ? { event_id: eventFilter } : {}),
      }, '-created_date', 10000),
    ]);

    // === Events: exclude draft and cancelled ===
    const validEvents = events.filter((e) => e.status === "active" || e.status === "finished");
    const statusEvents = statusFilter === "all" ? validEvents : validEvents.filter((e) => e.status === statusFilter);
    const eventScopedEvents = eventFilter === "all" ? statusEvents : statusEvents.filter((e) => e.id === eventFilter);
    const currentEvents = eventScopedEvents.filter((e) => inRange(e.start_date, current.start, current.end));
    const prevEvents = eventScopedEvents.filter((e) => inRange(e.start_date, previous.start, previous.end));

    const activeNow = currentEvents.filter((e) => e.status === "active").length;
    const activePrev = prevEvents.filter((e) => e.status === "active").length;
    const finishedNow = currentEvents.filter((e) => e.status === "finished").length;
    const finishedPrev = prevEvents.filter((e) => e.status === "finished").length;

    // === Users ===
    const usersNow = users.filter((u) => inRange(u.created_date, current.start, current.end)).length;
    const usersPrev = users.filter((u) => inRange(u.created_date, previous.start, previous.end)).length;

    // === Persons ===
    const personsNow = persons.filter((p) => inRange(p.created_date, current.start, current.end)).length;
    const personsPrev = persons.filter((p) => inRange(p.created_date, previous.start, previous.end)).length;

    // === Partners ===
    const partnersNow = partners.filter((p) => inRange(p.created_date, current.start, current.end)).length;
    const partnersPrev = partners.filter((p) => inRange(p.created_date, previous.start, previous.end)).length;

    // === Participants (event + profile scoped — already filtered in query) ===
    const currentParticipants = participants.filter((p) => inRange(p.created_date, current.start, current.end));
    const prevParticipants = participants.filter((p) => inRange(p.created_date, previous.start, previous.end));

    const uniqKey = (p) => `${p.event_id}:${p.person_id || p.id}`;
    const uniqNow = new Set(currentParticipants.map(uniqKey)).size;
    const uniqPrev = new Set(prevParticipants.map(uniqKey)).size;

    // === Leads (event scoped — already filtered in query) ===
    const currentLeads = leads.filter((l) => inRange(l.created_date, current.start, current.end));
    const prevLeads = leads.filter((l) => inRange(l.created_date, previous.start, previous.end));

    // === Chart: participants evolution ===
    const days = (current.end.getTime() - current.start.getTime()) / (1000 * 60 * 60 * 24);
    const bucketType = getBucketType(days);
    const buckets = new Map();
    participants.forEach((p) => {
      if (!inRange(p.created_date, current.start, current.end)) return;
      const key = getBucketKey(p.created_date, bucketType);
      if (!buckets.has(key)) buckets.set(key, new Set());
      buckets.get(key).add(uniqKey(p));
    });
    const participantsEvolution = Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, set]) => ({ date: formatBucketLabel(key, bucketType), count: set.size }));

    // === Chart: leads by partner ===
    const partnerMap = new Map(partners.map((p) => [p.id, p.trade_name || p.legal_name || "Sem nome"]));
    const leadsByPartnerMap = new Map();
    currentLeads.forEach((l) => {
      const name = partnerMap.get(l.partner_id) || "Sem parceiro";
      leadsByPartnerMap.set(name, (leadsByPartnerMap.get(name) || 0) + 1);
    });
    const leadsByPartner = Array.from(leadsByPartnerMap.entries())
      .map(([name, count]) => ({ name, leads: count }))
      .sort((a, b) => b.leads - a.leads)
      .slice(0, 10);

    // === Chart: events status ===
    const eventsStatus = [
      { name: "Ativos", value: activeNow },
      { name: "Encerrados", value: finishedNow },
    ];

    // === Top events table (all-time unique participants + leads per event) ===
    const participantsByEvent = new Map();
    participants.forEach((p) => {
      if (!participantsByEvent.has(p.event_id)) participantsByEvent.set(p.event_id, new Set());
      participantsByEvent.get(p.event_id).add(p.person_id || p.id);
    });
    const leadsByEvent = new Map();
    leads.forEach((l) => {
      leadsByEvent.set(l.event_id, (leadsByEvent.get(l.event_id) || 0) + 1);
    });
    const topEvents = eventScopedEvents
      .map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        uniqueParticipants: participantsByEvent.get(e.id)?.size || 0,
        leads: leadsByEvent.get(e.id) || 0,
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
        leads: { count: currentLeads.length, delta: pctChange(currentLeads.length, prevLeads.length) },
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