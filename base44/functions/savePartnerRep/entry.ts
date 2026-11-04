import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { canManagePartnerData, verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";
import { normalizeEmail } from "../../shared/identity.ts";
import { findAccountByEmail, inviteAccount, ensurePersonByEmail } from "../../shared/accountInvites.ts";

// 2026-11-04 — REPRESENTANTE PRECISA DE CONTA.
// O vínculo é da Person, mas só vale (access_status 'active') quando a pessoa
// tem User. Sem conta: o vínculo nasce 'pending' (is_active false) e o convite
// de cadastro é enviado; linkPendingPartnerReps o ativa no primeiro acesso.
// O partner_manager (ou o admin) reexecuta a associação quando a conta existir.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;

    const body = await req.json();
    const { id, action, partnerId, personId, roleInPartner, isPrimary, isActive, payload } = body;

    // Helper: mutual-exclusão do is_primary dentro do parceiro
    const clearOtherPrimaries = async (pid, exceptId) => {
      const others = await svc.entities.PartnerRepresentative.filter({
        partner_id: pid,
        is_primary: true,
        is_active: true,
        is_deleted: false,
      });
      await Promise.all(
        others.filter((r) => r.id !== exceptId).map((r) => svc.entities.PartnerRepresentative.update(r.id, { is_primary: false }))
      );
    };

    // Vínculo + conta da pessoa: ativa quando a conta existe, pendente quando não.
    const resolveAccess = async (rep) => {
      const persons = await svc.entities.Person.filter({ id: rep.person_id });
      const email = normalizeEmail(persons?.[0]?.contact_email);
      const account = email ? await findAccountByEmail(svc, email) : null;
      return { email, account };
    };

    const sendInvite = async (email) => {
      if (!email) return { invited: false, error: 'Pessoa sem e-mail de contato — não é possível convidar para cadastro.' };
      return await inviteAccount(svc, email);
    };

    // DELETE — soft delete
    if (action === 'delete' && id) {
      const reps = await svc.entities.PartnerRepresentative.filter({ id });
      const rep = reps?.[0];
      if (!rep) return Response.json({ error: 'Representante não encontrado.' }, { status: 404 });
      const ok = await canManagePartnerData(base44, user, rep.partner_id);
      if (!ok) return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      await svc.entities.PartnerRepresentative.update(id, { is_deleted: true });
      return Response.json({ ok: true, id });
    }

    // SET PRIMARY
    if (action === 'setPrimary' && id) {
      const reps = await svc.entities.PartnerRepresentative.filter({ id, is_deleted: false });
      const rep = reps?.[0];
      if (!rep) return Response.json({ error: 'Representante não encontrado.' }, { status: 404 });
      const ok = await canManagePartnerData(base44, user, rep.partner_id);
      if (!ok) return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      await clearOtherPrimaries(rep.partner_id, id);
      await svc.entities.PartnerRepresentative.update(id, { is_primary: true });
      return Response.json({ ok: true, id });
    }

    // RESEND INVITE — vínculo pendente aguardando a criação da conta
    if (action === 'resendInvite' && id) {
      const reps = await svc.entities.PartnerRepresentative.filter({ id, is_deleted: false });
      const rep = reps?.[0];
      if (!rep) return Response.json({ error: 'Representante não encontrado.' }, { status: 404 });
      const ok = await canManagePartnerData(base44, user, rep.partner_id);
      if (!ok) return Response.json({ error: 'Sem permissão.' }, { status: 403 });

      const { email, account } = await resolveAccess(rep);
      if (account) {
        await svc.entities.PartnerRepresentative.update(id, {
          user_id: account.id,
          is_active: true,
          access_status: 'active',
          invite_error: '',
        });
        return Response.json({ ok: true, id, status: 'active' });
      }
      const invite = await sendInvite(email);
      await svc.entities.PartnerRepresentative.update(id, {
        access_status: 'pending',
        is_active: false,
        invite_sent_at: new Date().toISOString(),
        invite_error: invite.error || '',
      });
      return Response.json({ ok: true, id, status: 'pending', invited: invite.invited, invite_error: invite.error });
    }

    // UPDATE
    if (id) {
      const reps = await svc.entities.PartnerRepresentative.filter({ id, is_deleted: false });
      const rep = reps?.[0];
      if (!rep) return Response.json({ error: 'Representante não encontrado.' }, { status: 404 });
      const ok = await canManagePartnerData(base44, user, rep.partner_id);
      if (!ok) return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      const p = payload || {};
      const clean: any = {};
      let inviteResult = null;

      if (p.is_active !== undefined) {
        if (p.is_active && !rep.user_id) {
          // Reativação de vínculo pendente: tenta vincular a conta agora.
          const { email, account } = await resolveAccess(rep);
          if (account) {
            clean.user_id = account.id;
            clean.is_active = true;
            clean.access_status = 'active';
            clean.invite_error = '';
          } else {
            const invite = await sendInvite(email);
            inviteResult = { invited: invite.invited, error: invite.error };
            clean.is_active = false;
            clean.access_status = 'pending';
            clean.invite_sent_at = new Date().toISOString();
            clean.invite_error = invite.error || '';
          }
        } else {
          clean.is_active = !!p.is_active;
        }
      }
      if (p.is_primary !== undefined) {
        clean.is_primary = !!p.is_primary;
        if (p.is_primary) await clearOtherPrimaries(rep.partner_id, id);
      }
      if (p.role_in_partner !== undefined) clean.role_in_partner = p.role_in_partner;
      await svc.entities.PartnerRepresentative.update(id, clean);
      return Response.json({
        ok: true,
        id,
        status: clean.access_status || undefined,
        invite: inviteResult,
      });
    }

    // CREATE — aceita personId (pessoa já existente) ou e-mail (resolve/cadastra).
    if (!partnerId || !roleInPartner || (!personId && !body.email)) {
      return Response.json({ error: 'Informe a pessoa (personId ou e-mail) e o papel.' }, { status: 400 });
    }

    // Quem pode: admin, o partner_manager da empresa, OU o GERENTE DO EVENTO
    // onde o parceiro está vinculado (mesma regra da leitura da lista).
    let allowed = await canManagePartnerData(base44, user, partnerId);
    if (!allowed && body.eventId) {
      const managerAuth = await verifyEventMembership(base44, user, body.eventId, EVENT_MANAGER_ROLES);
      if (managerAuth.authorized) {
        const links = await svc.entities.EventPartner.filter({
          event_id: body.eventId,
          partner_id: partnerId,
          is_deleted: false,
        });
        allowed = !!links?.[0];
      }
    }
    if (!allowed) return Response.json({ error: 'Sem permissão para gerenciar representantes deste parceiro.' }, { status: 403 });

    let person: any = null;
    if (personId) {
      const persons = await svc.entities.Person.filter({ id: personId });
      person = persons?.[0] || null;
      if (!person) return Response.json({ error: 'Pessoa não encontrada.' }, { status: 404 });
    } else {
      try {
        person = await ensurePersonByEmail(svc, { email: body.email, fullName: body.name });
      } catch (error: any) {
        if (error?.message === 'identity_ambiguous') {
          return Response.json({ error: 'Há mais de um cadastro de pessoa com este e-mail.' }, { status: 409 });
        }
        throw error;
      }
    }
    const resolvedPersonId = person.id;
    const email = normalizeEmail(person.contact_email);
    const account = email ? await findAccountByEmail(svc, email) : null;

    if (!account && !email) {
      return Response.json({ error: 'A pessoa precisa de e-mail de contato para ser convidada.' }, { status: 400 });
    }

    // Vínculo duplicado do mesmo papel não se repete (ativo ou pendente) —
    // checado ANTES de enviar convite, para não convidar em vínculo recusado.
    const existing = await svc.entities.PartnerRepresentative.filter({
      partner_id: partnerId,
      person_id: resolvedPersonId,
      role_in_partner: roleInPartner,
      is_deleted: false,
    });
    if (existing?.some((r) => r.is_active !== false || r.access_status === 'pending')) {
      return Response.json({ error: 'Já existe vínculo (ativo ou pendente) para esta pessoa e papel.' }, { status: 409 });
    }

    const invite = account ? { invited: false, error: '' } : await sendInvite(email);

    if (isPrimary && account) await clearOtherPrimaries(partnerId, null);
    const created = await svc.entities.PartnerRepresentative.create({
      partner_id: partnerId,
      person_id: resolvedPersonId,
      user_id: account?.id || '',
      role_in_partner: roleInPartner,
      is_primary: !!isPrimary && !!account,
      is_active: account ? isActive !== false : false,
      access_status: account ? 'active' : 'pending',
      invite_sent_at: account ? undefined : new Date().toISOString(),
      invite_error: account ? '' : (invite.error || ''),
    });

    return Response.json({
      ok: true,
      id: created.id,
      status: account ? 'active' : 'pending',
      invited: account ? false : invite.invited,
      invite_error: account ? '' : invite.error,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}