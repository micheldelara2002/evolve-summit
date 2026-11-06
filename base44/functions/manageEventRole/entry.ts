import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership } from "../../shared/eventAuth.ts";
import { grantEventRole } from "../../shared/eventInvites.ts";
import { normalizeEmail } from "../../shared/identity.ts";

/**
 * manageEventRole — curadores e avaliadores de um evento.
 *
 * Regra (2026-11-06): curador/avaliador precisa de CONTA (User) + Person. Quem
 * já usa o app é vinculado na hora; quem não usa recebe convite de cadastro e o
 * vínculo nasce no primeiro acesso (linkPendingInvites, via getOrCreatePerson).
 *
 * Só ADMIN ou o GERENTE do evento concede/revoga. Curador e avaliador não
 * administram papéis — o servidor recusa (o gate é 'manager', não 'team').
 */
const ROLES = ['curator', 'reviewer'];
const ROLE_LABELS: Record<string, string> = { curator: 'curador', reviewer: 'avaliador' };

async function isEventManager(base44: any, user: any, eventId: string) {
  const { authorized } = await verifyEventMembership(base44, user, eventId, ['manager']);
  return authorized;
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = (await req.json().catch(() => ({}))) || {};
    const action = String(body.action || 'list');
    const eventId = String(body.event_id || '');
    if (!eventId) return Response.json({ error: 'event_id ausente.' }, { status: 400 });

    const svc = base44.asServiceRole;

    // Leitura: gestão do evento. Curador/avaliador NÃO lista papéis.
    if (action === 'list') {
      if (!(await isEventManager(base44, user, eventId))) {
        return Response.json({ error: 'Apenas o gerente do evento gerencia curadores e avaliadores.' }, { status: 403 });
      }
      const [memberships, invites] = await Promise.all([
        svc.entities.EventMembership.filter({
          event_id: eventId,
          role: { $in: ROLES },
          is_active: true,
          is_deleted: false,
        }),
        svc.entities.EventInvite.filter({
          event_id: eventId,
          target_role: { $in: ROLES },
          status: 'pending',
          is_deleted: false,
        }),
      ]);
      return Response.json({
        memberships: (memberships || []).map((m: any) => ({
          id: m.id,
          role: m.role,
          person_id: m.person_id,
          person_name: m.person_name || '',
          user_id: m.user_id || '',
          user_email: m.user_email || '',
          has_account: !!m.user_id,
        })),
        invites: (invites || []).map((i: any) => ({
          id: i.id,
          role: i.target_role,
          email: i.email,
          invited_name: i.invited_name || '',
          invite_error: i.invite_error || '',
          invite_sent_at: i.invite_sent_at || '',
        })),
      });
    }

    if (action === 'grant') {
      if (!(await isEventManager(base44, user, eventId))) {
        return Response.json({ error: 'Apenas o gerente do evento adiciona curadores e avaliadores.' }, { status: 403 });
      }
      const role = String(body.role || '');
      if (!ROLES.includes(role)) return Response.json({ error: 'Papel inválido.' }, { status: 400 });

      const email = normalizeEmail(body.email || '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return Response.json({ error: 'Informe um e-mail válido.' }, { status: 400 });
      }
      const displayName = String(body.full_name || '').slice(0, 120);

      try {
        const result: any = await grantEventRole(base44, {
          eventId,
          email,
          displayName,
          role,
          actor: user,
        });
        if (result.status === 'linked') {
          return Response.json({ status: 'linked', membership_id: result.membership?.id || '' });
        }
        return Response.json({
          status: 'invited',
          invite: { invited: !!result.invited, error: result.inviteError || '' },
        });
      } catch (error: any) {
        const map: Record<string, [string, number]> = {
          event_not_found: ['Evento não encontrado.', 404],
          account_deleted: ['Esta conta foi excluída e não pode receber acesso.', 409],
          identity_ambiguous: ['Há mais de um cadastro de pessoa com este e-mail. Consolide o cadastro antes.', 409],
        };
        const mapped = map[error?.message];
        if (mapped) return Response.json({ error: mapped[0] }, { status: mapped[1] });
        throw error;
      }
    }

    if (action === 'revoke') {
      if (!(await isEventManager(base44, user, eventId))) {
        return Response.json({ error: 'Apenas o gerente do evento remove curadores e avaliadores.' }, { status: 403 });
      }
      const role = String(body.role || '');
      if (!ROLES.includes(role)) return Response.json({ error: 'Papel inválido.' }, { status: 400 });

      if (body.invite_id) {
        const invites = await svc.entities.EventInvite.filter({ id: String(body.invite_id), event_id: eventId });
        const invite = invites?.[0];
        if (!invite) return Response.json({ error: 'Convite não encontrado.' }, { status: 404 });
        await svc.entities.EventInvite.update(invite.id, { status: 'revoked' });
        return Response.json({ ok: true });
      }

      const membershipId = String(body.membership_id || '');
      if (!membershipId) return Response.json({ error: 'membership_id ausente.' }, { status: 400 });
      const rows = await svc.entities.EventMembership.filter({ id: membershipId, event_id: eventId, role });
      if (!rows?.length) return Response.json({ error: 'Vínculo não encontrado neste evento.' }, { status: 404 });
      await svc.entities.EventMembership.update(membershipId, { is_active: false, is_deleted: true });

      // Revogar o papel também tira a pessoa da banca: sem isso, quem voltasse a
      // receber o papel reentraria silenciosamente nas premiações já designadas.
      if (role === 'reviewer' && rows[0].user_id) {
        const configs = await svc.entities.AwardConfig.filter({ event_id: eventId, is_deleted: false });
        for (const cfg of configs || []) {
          let ids: string[] = [];
          try { ids = JSON.parse(cfg.assigned_reviewer_ids || '[]'); } catch { ids = []; }
          if (!Array.isArray(ids) || !ids.includes(rows[0].user_id)) continue;
          await svc.entities.AwardConfig.update(cfg.id, {
            assigned_reviewer_ids: JSON.stringify(ids.filter((id) => id !== rows[0].user_id)),
          });
        }
      }

      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Ação não suportada.' }, { status: 400 });
  } catch (error: any) {
    console.error('manageEventRole error:', error?.message);
    return Response.json({ error: error.message || `Falha ao gerenciar ${ROLE_LABELS.curator}.` }, { status: 500 });
  }
}