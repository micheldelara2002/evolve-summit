import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// P0.3 — Reconstrói EventStats + MetricBucket de um evento a partir das entidades
// autoritativas (Participant is_deleted:false, Lead). Admin-only, bounded por
// cursor/batches (BATCH=500). É a rede de segurança para drift nos counters.
//
// *** INVARIANTE DE NEGÓCIO (documentada e testada) ***
// Uma Person aparece no MÁXIMO uma vez como Participant(is_deleted:false) por evento.
// Logo unique_participants(evento) = count de Participant(is_deleted:false), e
// participants_by_role(evento,role,day) = count de Participant(is_deleted:false, role, day).
// Isso elimina a necessidade de um Set global de dedup — a reconciliação usa contagem
// direta com memória O(dias × papéis distintos), verdadeiramente bounded (suporta 5M
// Participants sem crescimento de memória com N).
// Risco residual: se a invariante for violada (pessoa duplicada no mesmo evento), a
// contagem superestima. O app impede duplicatas no create (PersonFormDialog/PessoasTab/
// CsvImport checam person_id/email antes de criar). reconcile NÃO detecta duplicatas
// (detectá-las exigiria O(N) de memória, contradizendo o requisito bounded).
//
// Fonte da verdade:
//   unique_participants        = count de Participant(is_deleted:false)
//   participants_by_role[d,r]  = count de Participant(is_deleted:false, role=r, day=d)
//   total_leads                = count de Leads (append-only)
//   leads[d,partner]           = count de Leads criados no dia d para o partner
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

    // --- Pass 1: participants is_deleted:false, cursor em 'id' desc, contagem direta ---
    // Memória: Map<day, number> + Map<day|role, number> = O(dias × papéis). Sem Set de IDs.
    let totalUnique = 0;
    const uniqByDay = new Map<string, number>();
    const roleByDay = new Map<string, number>(); // key: day|role
    const partBackfill: any[] = []; // P0.3 — records missing created_day (backfill para correção de borda)
    let pcursor: string | null = null;
    while (true) {
      const q: any = { event_id: eventId, is_deleted: false };
      if (pcursor) q.id = { $lt: pcursor };
      const batch = await svc.entities.Participant.filter(q, '-id', BATCH);
      if (batch.length === 0) break;
      pcursor = batch[batch.length - 1].id;
      for (const p of batch) {
        if (!p.created_date) continue;
        const dk = dayKey(p.created_date);
        totalUnique++;
        uniqByDay.set(dk, (uniqByDay.get(dk) || 0) + 1);
        const role = p.role_in_event || "attendee";
        const rk = `${dk}|${role}`;
        roleByDay.set(rk, (roleByDay.get(rk) || 0) + 1);
        if (!p.created_day) partBackfill.push({ id: p.id, created_day: dk });
      }
    }

    // --- Pass 2: leads, cursor em 'id' desc (bucket por day + partner_id) ---
    let totalLeads = 0;
    const leadsByDayPartner = new Map<string, number>(); // key: day|partnerId
    const leadBackfill: any[] = []; // P0.3 — records missing created_day
    let lcursor: string | null = null;
    while (true) {
      const q: any = { event_id: eventId };
      if (lcursor) q.id = { $lt: lcursor };
      const batch = await svc.entities.Lead.filter(q, '-id', BATCH);
      if (batch.length === 0) break;
      lcursor = batch[batch.length - 1].id;
      for (const l of batch) {
        totalLeads++;
        if (!l.created_date) continue;
        const dk = dayKey(l.created_date);
        const key = `${dk}|${l.partner_id || ""}`;
        leadsByDayPartner.set(key, (leadsByDayPartner.get(key) || 0) + 1);
        if (!l.created_day) leadBackfill.push({ id: l.id, created_day: dk });
      }
    }

    // --- Estado atual (soma TODAS as linhas de EventStats — consistente com o read-side,
    //     que soma tudo para tolerar a race do ensureEventStats que pode criar duplicatas) ---
    const existing = await svc.entities.EventStats.filter({ event_id: eventId });
    let currentUnique = 0;
    let currentLeads = 0;
    for (const s of existing) {
      currentUnique += s.unique_participants_count || 0;
      currentLeads += s.total_leads_count || 0;
    }
    const drift = {
      unique: totalUnique - currentUnique,
      leads: totalLeads - currentLeads,
    };

    if (dryRun) {
      return Response.json({
        eventId,
        dryRun: true,
        current: { unique: currentUnique, leads: currentLeads },
        target: { unique: totalUnique, leads: totalLeads },
        drift,
      });
    }

    // --- Aplicar EventStats (recria limpo) ---
    if (existing.length > 0) {
      await svc.entities.EventStats.deleteMany({ event_id: eventId });
    }
    await svc.entities.EventStats.create({
      event_id: eventId,
      unique_participants_count: totalUnique,
      total_leads_count: totalLeads,
    });

    // --- Aplicar MetricBucket (recria limpo: unique_participants + participants_by_role + leads) ---
    await svc.entities.MetricBucket.deleteMany({ event_id: eventId });
    const buckets: any[] = [];
    for (const [day, count] of uniqByDay.entries()) {
      buckets.push({ event_id: eventId, metric_type: 'unique_participants', bucket_date: day, partner_id: '', dimension: '', value: count });
    }
    for (const [key, count] of roleByDay.entries()) {
      const [day, role] = key.split('|');
      buckets.push({ event_id: eventId, metric_type: 'participants_by_role', bucket_date: day, partner_id: '', dimension: role, value: count });
    }
    for (const [key, count] of leadsByDayPartner.entries()) {
      const [day, partnerId] = key.split('|');
      buckets.push({ event_id: eventId, metric_type: 'leads', bucket_date: day, partner_id: partnerId || '', dimension: '', value: count });
    }
    for (let i = 0; i < buckets.length; i += 500) {
      await svc.entities.MetricBucket.bulkCreate(buckets.slice(i, i + 500));
    }

    // P0.3 — backfill de created_day em registros legados (necessário para correção de borda do dashboard)
    let backfilledParticipants = 0, backfilledLeads = 0;
    for (let i = 0; i < partBackfill.length; i += 500) {
      const chunk = partBackfill.slice(i, i + 500);
      try { await svc.entities.Participant.bulkUpdate(chunk); backfilledParticipants += chunk.length; } catch {}
    }
    for (let i = 0; i < leadBackfill.length; i += 500) {
      const chunk = leadBackfill.slice(i, i + 500);
      try { await svc.entities.Lead.bulkUpdate(chunk); backfilledLeads += chunk.length; } catch {}
    }

    return Response.json({
      ok: true,
      eventId,
      applied: true,
      uniqueParticipants: totalUnique,
      totalLeads,
      bucketsCreated: buckets.length,
      previousDrift: drift,
      backfill: { participants: backfilledParticipants, leads: backfilledLeads },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});