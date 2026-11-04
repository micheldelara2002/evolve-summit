import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { normalizeEmail } from "../../shared/identity.ts";
import { grantEventRole } from "../../shared/eventInvites.ts";
import { verifyEventMembership } from "../../shared/eventAuth.ts";

// 2026-11-04 — O ADMIN define quem gerencia o evento pelo e-mail.
// Conta existente → vínculo imediato. Sem conta → convite enviado e o vínculo
// nasce sozinho no primeiro acesso (shared/eventInvites).
export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const { action = 'invite', eventId, email, name, role = 'manager', inviteId } = body;

    // 2026-11-04 — ADMIN define gerentes; o GERENTE do evento cadastra a
    // própria equipe (staff). 'TEAM' não gerencia equipe.
    const isAdmin = user.role === 'admin';
    let isEventManager = false;
    if (!isAdmin && eventId) {
      const { authorized } = await verifyEventMembership(base44, user, eventId, ['manager']);
      isEventManager = authorized;
    }
    const managerScope = isEventManager && (action === 'list' || action === 'revoke' || role === 'team');
    if (!isAdmin && !managerScope) {
      return Response.json({ error: 'Sem permissão para gerenciar acessos deste evento.' }, { status: 403 });
    }
    if (!isAdmin && role === 'manager') {
      return Response.json({ error: 'Apenas administradores definem gerentes de evento.' }, { status: 403 });
    }

    if (action === 'list') {
      if (!eventId) return Response.json({ error: 'eventId é obrigatório.' }, { status: 400 });
      const invites = await svc.entities.EventInvite.filter({ event_id: eventId, is_deleted: false });
      return Response.json({ invites });
    }

    if (action === 'revoke') {
      if (!inviteId) return Response.json({ error: 'inviteId é obrigatório.' }, { status: 400 });
      await svc.entities.EventInvite.update(inviteId, { status: 'revoked', is_deleted: true });
      return Response.json({ ok: true });
    }

    if (action !== 'invite') {
      return Response.json({ error: 'Ação não suportada.' }, { status: 400 });
    }

    const emailNorm = normalizeEmail(email);
    if (!eventId || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNorm)) {
      return Response.json({ error: 'Informe um e-mail válido e o evento.' }, { status: 400 });
    }
    if (!['manager', 'team'].includes(role)) {
      return Response.json({ error: 'Papel inválido para este convite.' }, { status: 400 });
    }

    const result = await grantEventRole(base44, {
      eventId,
      email: emailNorm,
      displayName: name,
      role,
      actor: user,
    });

    return Response.json(result);
  } catch (error: any) {
    const map: Record<string, [string, number]> = {
      event_not_found: ['Evento não encontrado.', 404],
      account_deleted: ['Esta conta foi excluída e não pode receber acesso.', 409],
      identity_ambiguous: ['Há mais de um cadastro de pessoa com este e-mail. Consolide o cadastro antes de conceder acesso.', 409],
    };
    const mapped = map[error?.message];
    if (mapped) return Response.json({ error: mapped[0] }, { status: mapped[1] });
    console.error('manageEventInvite error:', error?.message || error);
    return Response.json({ error: 'Não foi possível conceder o acesso ao evento.' }, { status: 500 });
  }
}