// saveBoothLead — Lote 4. Registro de visita a estande (Lead source=booth_scan)
// movido para o servidor. Valida que o participante é do próprio usuário
// (email/person_id), snapshot dos dados da Person, e incrementa contadores
// de leads do evento (EventStats + bucket diário com partner_id).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { resolveUserPersonId } from '../../shared/eventAuth.ts';
import { validIds, isValidId } from '../../shared/idGuard.ts';
import { incLeads } from '../../shared/businessMetrics.ts';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Não autenticado.' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const eventId = body.eventId;
    const partnerId = body.partnerId;
    const participantId = body.participantId;
    const personId = body.personId;
    if (!eventId || !partnerId || !participantId) {
      return Response.json({ error: 'eventId, partnerId e participantId são obrigatórios.' }, { status: 400 });
    }
    if (!validIds([eventId, partnerId, participantId]).length) {
      return Response.json({ error: 'Registro não encontrado.' }, { status: 404 });
    }

    const svc = base44.asServiceRole;

    // Participante deve pertencer ao próprio chamador (email ou person_id)
    const participants = await svc.entities.Participant.filter({
      id: participantId,
      event_id: eventId,
      is_deleted: false,
    });
    const participant = participants[0];
    if (!participant) return Response.json({ error: 'Participante não encontrado neste evento.' }, { status: 404 });

    const isAdmin = user.role === 'admin';
    const callerPersonId = await resolveUserPersonId(base44, user);
    const ownsParticipant =
      (participant.email && user.email && participant.email.toLowerCase() === user.email.toLowerCase()) ||
      (participant.person_id && callerPersonId && participant.person_id === callerPersonId);
    if (!isAdmin && !ownsParticipant) {
      return Response.json({ error: 'Sem permissão para registrar visita para este participante.' }, { status: 403 });
    }

    const partner = (await svc.entities.Partner.filter({ id: partnerId }))[0] || null;
    if (!partner) return Response.json({ error: 'Parceiro não encontrado.' }, { status: 404 });

    // Snapshot da Person (se vinculada)
    let person = null;
    const targetPersonId = personId || participant.person_id;
    if (isValidId(targetPersonId)) {
      person = (await svc.entities.Person.filter({ id: targetPersonId }))[0] || null;
    }

    const now = new Date().toISOString();
    const lead = await svc.entities.Lead.create({
      event_id: eventId,
      partner_id: partnerId,
      participant_id: participantId,
      person_id: person?.id || null,
      participant_name: participant.full_name || '',
      participant_email: participant.email || '',
      source: 'booth_scan',
      visited_at: now,
      created_day: now.slice(0, 10),
      person_phone: person?.phone || '',
      person_linkedin: person?.linkedin || '',
      person_company: person?.company || '',
      person_job_title: person?.job_title || '',
    });

    // Contadores de leads (EventStats + bucket diário) — best-effort
    try {
      await incLeads(svc, eventId, partnerId, lead?.created_date || now);
    } catch (e) { /* best-effort */ }

    return Response.json({ lead });
  } catch (error) {
    console.error('saveBoothLead error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}