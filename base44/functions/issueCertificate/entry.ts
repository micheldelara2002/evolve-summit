import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { eventId, participantId, tipo, template, customTemplateId, sessionId } = await req.json();

    if (!eventId || !participantId || !tipo) {
      return Response.json({ error: 'Parâmetros obrigatórios ausentes.' }, { status: 400 });
    }

    // P0.2: Event-scoped authorization — admin or event manager/team
    const certAuth = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
    if (!certAuth.authorized) {
      return Response.json({ error: 'Sem permissão para emitir certificados neste evento.' }, { status: 403 });
    }

    // Fetch participant fresh from DB
    const participants = await base44.asServiceRole.entities.Participant.filter({
      id: participantId,
      event_id: eventId,
      is_deleted: false,
    });
    if (!participants.length) {
      return Response.json({ error: 'Participante não encontrado.' }, { status: 404 });
    }
    const participant = participants[0];

    // Idempotency: check if certificate already exists
    const existingFilter = {
      event_id: eventId,
      participant_id: participantId,
      tipo,
      is_deleted: false,
    };
    if (tipo === 'palestra' && sessionId) {
      existingFilter.session_id = sessionId;
    }
    const existing = await base44.asServiceRole.entities.Certificate.filter(existingFilter);
    if (existing && existing.length > 0) {
      return Response.json({ certificate: existing[0], alreadyExisted: true });
    }

    // Consistency check: palestra certificate requires session speaker match
    if (tipo === 'palestra' && sessionId) {
      const sessions = await base44.asServiceRole.entities.Session.filter({
        id: sessionId,
        event_id: eventId,
        is_deleted: false,
      });
      const session = sessions[0];
      if (!session) {
        return Response.json({ error: 'Sessão não encontrada.' }, { status: 404 });
      }
      if (session.speaker_id !== participantId) {
        return Response.json({ error: 'Este palestrante não está vinculado a esta sessão.' }, { status: 400 });
      }
    }

    // Generate unique hash with server-side collision check (up to 5 attempts)
    let finalHash = generateSecureHash();
    for (let attempt = 0; attempt < 5; attempt++) {
      const collision = await base44.asServiceRole.entities.Certificate.filter({
        hash_code: finalHash,
        is_deleted: false,
      });
      if (!collision || collision.length === 0) break;
      finalHash = generateSecureHash();
    }

    const certificate = await base44.asServiceRole.entities.Certificate.create({
      event_id: eventId,
      person_id: participant.person_id || '',
      participant_id: participantId,
      session_id: tipo === 'palestra' ? (sessionId || undefined) : undefined,
      tipo,
      template: customTemplateId ? 'classico' : (template || 'classico'),
      custom_template_id: customTemplateId || undefined,
      hash_code: finalHash,
      issued_by_user_id: user.id,
      issued_by_name: user.full_name,
      email_sent: false,
    });

    return Response.json({ certificate, alreadyExisted: false });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});

function generateSecureHash() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return (hex.slice(0, 8) + '-' + hex.slice(8, 16)).toUpperCase();
}