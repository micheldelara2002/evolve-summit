import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveUserPersonId, verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/<[^>]*>/g, '').replace(/javascript:/gi, '').replace(/on\w+\s*=/gi, '').trim();
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json();
    const { id, eventId, participantId, personId, job_title, contact_email, description, poster_name, poster_photo_url } = body;
    const userPersonId = await resolveUserPersonId(base44, user);

    if (id) {
      // UPDATE
      const jobs = await base44.asServiceRole.entities.JobPosting.filter({ id, is_deleted: false });
      const job = jobs?.[0];
      if (!job) return Response.json({ error: 'Vaga não encontrada.' }, { status: 404 });

      const isOwner = !!userPersonId && job.person_id === userPersonId;
      const { authorized: isMod } = await verifyEventMembership(base44, user, job.event_id, EVENT_MANAGER_ROLES);
      if (!isOwner && !isMod) return Response.json({ error: 'Sem permissão para editar esta vaga.' }, { status: 403 });

      const payload = {};
      if (job_title !== undefined) payload.job_title = sanitizeText(job_title);
      if (contact_email !== undefined) payload.contact_email = String(contact_email).trim();
      if (description !== undefined) payload.description = sanitizeText(String(description).slice(0, 250));
      await base44.asServiceRole.entities.JobPosting.update(id, payload);
      return Response.json({ ok: true, id });
    }

    // CREATE
    if (!eventId || !participantId || !job_title || !contact_email) {
      return Response.json({ error: 'Parâmetros obrigatórios ausentes.' }, { status: 400 });
    }
    const participants = await base44.asServiceRole.entities.Participant.filter({ id: participantId, is_deleted: false, registration_status: { $ne: 'cancelled' } });
    const p = participants?.[0];
    if (!p) return Response.json({ error: 'Participante não encontrado.' }, { status: 404 });
    const isOwn = (!!userPersonId && p.person_id === userPersonId) || (p.email && p.email.toLowerCase() === user.email.toLowerCase());
    if (!isOwn && user.role !== 'admin') {
      return Response.json({ error: 'Sem permissão para postar como este participante.' }, { status: 403 });
    }

    const created = await base44.asServiceRole.entities.JobPosting.create({
      event_id: eventId,
      participant_id: participantId,
      person_id: p.person_id || personId,
      poster_name: poster_name || p.full_name || '',
      poster_photo_url: poster_photo_url || '',
      job_title: sanitizeText(job_title),
      contact_email: String(contact_email).trim(),
      description: sanitizeText(String(description || '').slice(0, 250)),
    });
    return Response.json({ ok: true, id: created.id });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});