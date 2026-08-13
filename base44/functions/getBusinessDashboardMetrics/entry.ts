import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// P0.3 — Backend-driven aggregation for the Business Dashboard (read-side materializado).
//
// Read-side:
//   - EventStats  → TopEvents (all-time unique_participants_count, total_leads_count) — O(1)/evento
//   - MetricBucket(unique_participants, daily) → uniqNow/Prev + ParticipantsEvolution.
//     buildExactDailyUnique() soma buckets diários e aplica TRIM de boundary-day
//     (query bounded de 1 dia) para preservar inRange(created_date, start, end) EXATO.
//   - Leads (Now/Prev, LeadsByPartner) → query date-bounded [prev_start, current_end] em memória
//     (leads são append-only, menor volume; dimensão partner_id inviabiliza bucket por partner)
//   - profileFilter != 'all' → fallback bounded de participantes (bucket não tem dimensão role)
//   - Users/Persons/Partners/Events → date-bounded ou small (igual antes)
//
// Semântica preservada EXATAMENTE igual à versão in-memory anterior; a materialização remove
// o cap de 10000 e o load global de participants.
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
function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function endOfDay(d: Date): Date { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }

// Conta unique participants (is_deleted:false) criados em [lo, hi] (datetimes). Bounded.
async function countUniqueParticipants(svc, eventId, lo: Date, hi: Date, profileFilter: string): Promise<number> {
  const q: any = { is_deleted: false };
  if (eventId) q.event_id = eventId;
  if (profileFilter && profileFilter !== "all") q.role_in_event = profileFilter;
  q.created_date = { $gte: lo.toISOString(), $lte: hi.toISOString() };
  const records = await svc.entities.Participant.filter(q, "-created_date", 10000);
  const set = new Set();
  for (const p of records) set.add(`${p.event_id}:${p.person_id || p.id}`);
  return set.size;
}

// Map<dayKey, exactUniqueCount> para [startDT, endDT].
// - profileFilter='all': soma buckets diários + trim de boundary-day (startDay e endDay) via
//   2 queries bounded. Dias interiores usam o bucket direto (dias inteiros = exato).
// - profileFilter!=all: fallback — query bounded de participantes no período, agrupados por dia.
async function buildExactDailyUnique(svc, eventId, startDT: Date, endDT: Date, profileFilter: string): Promise<Map<string, number>> {
  if (profileFilter && profileFilter !== "all") {
    const q: any = { is_deleted: false, role_in_event: profileFilter };
    if (eventId) q.event_id = eventId;
    q.created_date = { $gte: startDT.toISOString(), $lte: endDT.toISOString() };
    const records = await svc.entities.Participant.filter(q, "-created_date", 10000);
    const byDay = new Map<string, Set<string>>();
    for (const p of records) {
      const dk = dayKeyOf(new Date(p.created_date));
      if (!byDay.has(dk)) byDay.set(dk, new Set());
      byDay.get(dk).add(`${p.event_id}:${p.person_id || p.id}`);
    }
    const out = new Map<string, number>();
    for (const [k, s] of byDay) out.set(k, s.size);
    return out;
  }
  const startDay = dayKeyOf(startDT);
  const endDay = dayKeyOf(endDT);
  const bf: any = { metric_type: "unique_participants", bucket_date: { $gte: startDay, $lte: endDay } };
  if (eventId) bf.event_id = eventId;
  const buckets = await svc.entities.MetricBucket.filter(bf, undefined, 20000);
  const byDay = new Map<string, number>();
  for (const b of buckets) byDay.set(b.bucket_date, (byDay.get(b.bucket_date) || 0) + (b.value || 0));

  // Trim startDay: subtrai criados antes de startDT
  const sdStart = startOfDay(startDT);
  if (startDT.getTime() > sdStart.getTime()) {
    const before = await countUniqueParticipants(svc, eventId, sdStart, new Date(startDT.getTime() - 1), profileFilter);
    byDay.set(startDay, (byDay.get(startDay) || 0) - before);
  }
  // Trim endDay: subtrai criados depois de endDT
  const edEnd = endOfDay(endDT);
  if (endDT.getTime() < edEnd.getTime()) {
    const after = await countUniqueParticipants(svc, eventId, new Date(endDT.getTime() + 1), edEnd, profileFilter);
    byDay.set(endDay, (byDay.get(endDay) || 0) - after);
  }
  return byDay;
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
    const combinedStartISO = previous.start.toISOString();
    const currentEndISO = current.end.toISOString();
    const evId = eventFilter !== 'all' ? eventFilter : null;
    const svc = base44.asServiceRole;

    const [events, partners, users, persons, eventStats] = await Promise.all([
      svc.entities.Event.filter({ is_deleted: false }, '-created_date', 5000),
      svc.entities.Partner.filter({ is_deleted: false }, '-created_date', 5000),
      svc.entities.User.filter({ created_date: { $gte: combinedStartISO, $lte: currentEndISO } }, '-created_date', 5000),
      svc.entities.Person.filter({ created_date: { $gte: combinedStartISO, $lte: currentEndISO } }, '-created_date', 5000),
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

    // === Users / Persons / Partners (date-bounded in-memory) ===
    const usersNow = users.filter((u) => inRange(u.created_date, current.start, current.end)).length;
    const usersPrev = users.filter((u) => inRange(u.created_date, previous.start, previous.end)).length;
    const personsNow = persons.filter((p) => inRange(p.created_date, current.start, current.end)).length;
    const personsPrev = persons.filter((p) => inRange(p.created_date, previous.start, previous.end)).length;
    const partnersNow = partners.filter((p) => inRange(p.created_date, current.start, current.end)).length;
    const partnersPrev = partners.filter((p) => inRange(p.created_date, previous.start, previous.end)).length;

    // === uniqNow/Prev + Evolution via buildExactDailyUnique (buckets + trim) ===
    const [curDayMap, prevDayMap] = await Promise.all([
      buildExactDailyUnique(svc, evId, current.start, current.end, profileFilter),
      buildExactDailyUnique(svc, evId, previous.start, previous.end, profileFilter),
    ]);
    const uniqNow = Array.from(curDayMap.values()).reduce((s, v) => s + Math.max(0, v), 0);
    const uniqPrev = Array.from(prevDayMap.values()).reduce((s, v) => s + Math.max(0, v), 0);

    // ParticipantsEvolution: agrega curDayMap em display buckets (day/week/month)
    const days = (current.end.getTime() - current.start.getTime()) / (1000 * 60 * 60 * 24);
    const bucketType = getBucketType(days);
    const displayMap = new Map<string, number>();
    for (const [dk, count] of curDayMap.entries()) {
      const displayKey = getBucketKey(dk + "T12:00:00", bucketType);
      displayMap.set(displayKey, (displayMap.get(displayKey) || 0) + Math.max(0, count));
    }
    const participantsEvolution = Array.from(displayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => ({ date: formatBucketLabel(key, bucketType), count }));

    // === Leads: query date-bounded [prev_start, current_end], in-memory ===
    const leadQ: any = {};
    if (evId) leadQ.event_id = evId;
    leadQ.created_date = { $gte: combinedStartISO, $lte: currentEndISO };
    const leads = await svc.entities.Lead.filter(leadQ, '-created_date', 10000);
    const currentLeads = leads.filter((l) => inRange(l.created_date, current.start, current.end));
    const prevLeads = leads.filter((l) => inRange(l.created_date, previous.start, previous.end));

    // === Leads by partner (current period, in-memory) ===
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