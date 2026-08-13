import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { incUniqueParticipant, decUniqueParticipant, incLeads } from "../../shared/businessMetrics.ts";

// P0.3 — Ponto único de manutenção dos counters materializados (EventStats/MetricBucket)
// chamado pelo frontend após mutations de Participant/Lead. Best-effort: a mutation principal
// já sucedeu; falha aqui não bloqueia — reconcile corrige drift.
//
// Ações:
//   incParticipant   { eventId, createdDateISO }
//   decParticipant   { eventId, createdDateISO }   — usa created_date ORIGINAL do Participant
//   incLeads         { eventId, createdDateISO, count? }
//   bulkIncParticipants { eventId, createdDates: [iso...] }

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = base44.asServiceRole;
    const body = await req.json();
    const { action } = body;

    if (action === 'incParticipant') {
      const { eventId, createdDateISO } = body;
      if (!eventId || !createdDateISO) return Response.json({ error: 'eventId e createdDateISO obrigatórios' }, { status: 400 });
      await incUniqueParticipant(svc, eventId, createdDateISO);
      return Response.json({ ok: true });
    }
    if (action === 'decParticipant') {
      const { eventId, createdDateISO } = body;
      if (!eventId || !createdDateISO) return Response.json({ error: 'eventId e createdDateISO obrigatórios' }, { status: 400 });
      await decUniqueParticipant(svc, eventId, createdDateISO);
      return Response.json({ ok: true });
    }
    if (action === 'incLeads') {
      const { eventId, createdDateISO, count } = body;
      if (!eventId || !createdDateISO) return Response.json({ error: 'eventId e createdDateISO obrigatórios' }, { status: 400 });
      await incLeads(svc, eventId, createdDateISO, count || 1);
      return Response.json({ ok: true });
    }
    if (action === 'bulkIncParticipants') {
      const { eventId, createdDates } = body;
      if (!eventId || !Array.isArray(createdDates)) return Response.json({ error: 'eventId e createdDates[] obrigatórios' }, { status: 400 });
      for (const iso of createdDates) {
        if (iso) await incUniqueParticipant(svc, eventId, iso);
      }
      return Response.json({ ok: true, count: createdDates.length });
    }
    return Response.json({ error: 'action inválido' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
});