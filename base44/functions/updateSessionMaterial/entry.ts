import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireActiveUser } from "../../shared/accountSecurity.ts";

/**
 * updateSessionMaterial — escrita específica e deliberada (Lote 2 RLS).
 *
 * O ÚNICO campo de Session que esta função pode alterar é `material_url`.
 * Não existe updateSession genérico — esta operação é intencionalmente
 * restrita para que um palestrante só atualize o material da própria sessão.
 *
 * Autorização (não baseada somente em User.role):
 *   1. usuário ativo;
 *   2. Session existe e não está soft-deleted;
 *   3. caller é Participant ativo com role_in_event='speaker' no evento da Session;
 *   4. session.speaker_id === callerParticipant.id (posse da sessão).
 *
 * Falha rápida com 403 se qualquer cheque de posse falhar. Admin NÃO é
 * autorizado por esta função (admin edita material via SDK direto no
 * EventStructureManager, protegido por AdminRoute + RLS admin-only).
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { sessionId, materialUrl } = body;
    if (!sessionId || typeof sessionId !== 'string') {
      return Response.json({ error: 'sessionId é obrigatório.' }, { status: 400 });
    }
    if (materialUrl !== null && typeof materialUrl !== 'string') {
      return Response.json({ error: 'materialUrl inválido.' }, { status: 400 });
    }

    const svc = base44.asServiceRole;

    // Localiza a Session (service role) — responde de forma controlada em 404,
    // inclusive quando o formato do id é rejeitado pelo driver antes da consulta.
    let sessions;
    try {
      sessions = await svc.entities.Session.filter({ id: sessionId });
    } catch {
      return Response.json({ error: 'Sessão não encontrada.' }, { status: 404 });
    }
    const session = sessions?.[0];
    if (!session) {
      return Response.json({ error: 'Sessão não encontrada.' }, { status: 404 });
    }
    if (session.is_deleted) {
      return Response.json({ error: 'Sessão removida.' }, { status: 400 });
    }

    const eventId = session.event_id;

    // Resolve person_id do caller (Participant matching por person/email).
    let personId = user.person_id || null;
    if (!personId && user.email) {
      const persons = await svc.entities.Person.filter({ contact_email: user.email, is_active: true });
      personId = persons?.[0]?.id || null;
    }

    // Caller precisa ser speaker ativo neste evento.
    const participants = await svc.entities.Participant.filter({ event_id: eventId, is_deleted: false });
    const callerParticipant = participants.find(
      (p) =>
        p.role_in_event === 'speaker' &&
        p.registration_status !== 'cancelled' &&
        ((personId && p.person_id === personId) || (user.email && p.email === user.email))
    );

    if (!callerParticipant) {
      return Response.json(
        { error: 'Somente o palestrante da sessão pode alterar o material.' },
        { status: 403 }
      );
    }

    // Posse: a sessão deve pertencer a este palestrante.
    if (session.speaker_id !== callerParticipant.id) {
      return Response.json(
        { error: 'Você não é o palestrante desta sessão.' },
        { status: 403 }
      );
    }

    // Atualiza SOMENTE material_url.
    await svc.entities.Session.update(session.id, { material_url: materialUrl });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}