// manageSessionAttendance — Lote 4. Presença em sessão movida para o servidor.
//   action='status'    → consulta isPresent do chamador na sessão
//   action='register'  → dedupe + checagem de capacidade + create + Lead (sessão com palestrante)
//   action='unregister' → marca is_present=false
// Autorização: o participante é do próprio chamador (email/person_id), admin,
// ou gestor do evento. Contadores de leads (sessão) incrementados aqui.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { resolveUserPersonId, verifyEventMembership, EVENT_MANAGER_ROLES } from '../../shared/eventAuth.ts';
import { validIds } from '../../shared/idGuard.ts';
import { incLeads } from '../../shared/businessMetrics.ts';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Não autenticado.' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const sessionId = body.sessionId;
    const participantId = body.participantId;
    const action = String(body.action || '');
    if (!sessionId || !participantId || !action) {
      return Response.json({ error: 'sessionId, participantId e action são obrigatórios.' }, { status: 400 });
    }
    if (!validIds([sessionId]).length || !validIds([participantId]).length) {
      return Response.json({ error: 'Sessão ou participante não encontrado.' }, { status: 404 });
    }
    if (!['status', 'register', 'unregister'].includes(action)) {
      return Response.json({ error: 'Ação inválida.' }, { status: 400 });
    }

    const svc = base44.asServiceRole;
    const sessions = await svc.entities.Session.filter({ id: sessionId, is_deleted: false });
    const session = sessions[0];
    if (!session) return Response.json({ error: 'Sessão não encontrada.' }, { status: 404 });

    const participants = await svc.entities.Participant.filter({
      id: participantId,
      event_id: session.event_id,
      is_deleted: false,
    });
    const participant = participants[0];
    if (!participant) return Response.json({ error: 'Participante não encontrado neste evento.' }, { status: 404 });

    // Autorização: dono do registro, admin ou gestor do evento
    const isAdmin = user.role === 'admin';
    const callerPersonId = await resolveUserPersonId(base44, user);
    const ownsParticipant =
      (participant.email && user.email && participant.email.toLowerCase() === user.email.toLowerCase()) ||
      (participant.person_id && callerPersonId && participant.person_id === callerPersonId);
    if (!isAdmin && !ownsParticipant) {
      const { authorized } = await verifyEventMembership(base44, user, session.event_id, EVENT_MANAGER_ROLES);
      if (!authorized) {
        return Response.json({ error: 'Sem permissão para este participante.' }, { status: 403 });
      }
    }

    // Presença atual (re-check server-side sempre — previne duplicatas/cache stale)
    const attendances = await svc.entities.SessionAttendance.filter({
      session_id: sessionId,
      participant_id: participantId,
    });
    const present = attendances.find((a) => a.is_present !== false) || null;

    if (action === 'status') {
      return Response.json({ isPresent: !!present, attendance: present });
    }

    if (action === 'unregister') {
      if (present) {
        await svc.entities.SessionAttendance.update(present.id, { is_present: false });
      }
      return Response.json({ isPresent: false });
    }

    // register
    if (present) {
      return Response.json({ isPresent: true, attendance: present });
    }
    // Capacidade da sessão (null/0 = sem limite, ex: eventos online)
    if (session.capacity && session.capacity > 0) {
      const allPresent = await svc.entities.SessionAttendance.filter({
        session_id: sessionId,
        is_present: true,
      });
      if (allPresent.length >= session.capacity) {
        return Response.json({ error: 'A sessão está lotada. Não é possível registrar presença.' }, { status: 409 });
      }
    }

    const now = new Date().toISOString();
    const attendance = await svc.entities.SessionAttendance.create({
      event_id: session.event_id,
      session_id: sessionId,
      participant_id: participantId,
      person_id: participant.person_id || callerPersonId || null,
      is_present: true,
      registered_at: now,
    });

    // Lead de sessão (o palestrante vê quem assistiu) + contadores — best-effort
    if (session.speaker_name) {
      try {
        const lead = await svc.entities.Lead.create({
          event_id: session.event_id,
          participant_id: participantId,
          participant_name: participant.full_name || '',
          participant_email: participant.email || '',
          source: 'session',
          notes: `Presença na sessão: ${session.title || ''}`.slice(0, 500),
          created_day: now.slice(0, 10),
        });
        await incLeads(svc, session.event_id, '', lead?.created_date || now);
      } catch (e) { /* best-effort */ }
    }

    return Response.json({ isPresent: true, attendance });
  } catch (error) {
    console.error('manageSessionAttendance error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}