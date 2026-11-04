import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

// 2026-11-04 — RELAÇÃO PARCEIRO ↔ EVENTO.
// O Partner é global; o vínculo é por evento. Porta única porque a RLS de
// EventPartner é admin-only e o gerente do evento também gerencia o vínculo.
//   associate   → cria o vínculo (+ representantes escolhidos como participantes)
//   unlink      → remove o vínculo (soft delete)
//   update_plan → troca o plano de patrocínio
export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;

    const body = await req.json().catch(() => ({}));
    const action = body.action || 'associate';
    const eventId = body.eventId;

    if (!eventId) return Response.json({ error: 'eventId é obrigatório.' }, { status: 400 });

    const managerAuth = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
    if (!managerAuth.authorized) {
      return Response.json({ error: 'Sem permissão para gerenciar parceiros deste evento.' }, { status: 403 });
    }

    const plan = ['diamante', 'ouro', 'prata', 'bronze', 'apoiador'].includes(body.sponsorshipPlan)
      ? body.sponsorshipPlan
      : 'apoiador';

    if (action === 'unlink' || action === 'update_plan') {
      if (!body.eventPartnerId) return Response.json({ error: 'eventPartnerId é obrigatório.' }, { status: 400 });
      const rows = await svc.entities.EventPartner.filter({
        id: body.eventPartnerId,
        event_id: eventId,
        is_deleted: false,
      });
      if (!rows?.[0]) return Response.json({ error: 'Vínculo não encontrado neste evento.' }, { status: 404 });
      await svc.entities.EventPartner.update(body.eventPartnerId, action === 'unlink'
        ? { is_deleted: true, is_active: false }
        : { sponsorship_plan: plan });
      return Response.json({ ok: true });
    }

    // ── associate ──────────────────────────────────────────────────────────
    const partnerId = body.partnerId;
    if (!partnerId) return Response.json({ error: 'Parceiro é obrigatório.' }, { status: 400 });

    const repIds: string[] = Array.isArray(body.repIds) ? body.repIds.filter(Boolean) : [];

    const [events, partners] = await Promise.all([
      svc.entities.Event.filter({ id: eventId, is_deleted: false }),
      svc.entities.Partner.filter({ id: partnerId, is_deleted: false }),
    ]);
    if (!events?.[0]) return Response.json({ error: 'Evento não encontrado.' }, { status: 404 });
    if (!partners?.[0]) return Response.json({ error: 'Parceiro não encontrado.' }, { status: 404 });

    const existing = await svc.entities.EventPartner.filter({
      event_id: eventId,
      partner_id: partnerId,
      is_deleted: false,
    });
    if (existing?.[0]) {
      return Response.json({
        error: 'Este parceiro já está associado ao evento.',
        event_partner_id: existing[0].id,
      }, { status: 409 });
    }

    const eventPartner = await svc.entities.EventPartner.create({
      event_id: eventId,
      partner_id: partnerId,
      sponsorship_plan: plan,
      is_active: true,
      is_deleted: false,
    });

    let participantsCreated = 0;
    if (repIds.length) {
      const reps = await svc.entities.PartnerRepresentative.filter({
        id: { $in: repIds },
        partner_id: partnerId,
        is_active: true,
        is_deleted: false,
      });
      const personIds = [...new Set((reps || []).map((r: any) => r.person_id).filter(Boolean))];
      const persons = personIds.length
        ? await svc.entities.Person.filter({ id: { $in: personIds } })
        : [];
      const personMap = new Map((persons || []).map((p: any) => [p.id, p]));
      const current = await svc.entities.Participant.filter({ event_id: eventId, is_deleted: false });

      for (const rep of reps || []) {
        const person: any = personMap.get(rep.person_id);
        if (!person) continue;
        const email = String(person.contact_email || '').trim().toLowerCase();
        const existingParticipant = (current || []).find(
          (p: any) => (p.person_id && p.person_id === rep.person_id) || (email && String(p.email || '').toLowerCase() === email),
        );
        if (existingParticipant) {
          if (existingParticipant.role_in_event !== 'partner_rep') {
            await svc.entities.Participant.update(existingParticipant.id, {
              role_in_event: 'partner_rep',
              person_id: rep.person_id,
              photo_url: person.photo_url || existingParticipant.photo_url || '',
            });
          }
          continue;
        }
        await svc.entities.Participant.create({
          event_id: eventId,
          full_name: person.full_name || '',
          email,
          phone: person.phone || '',
          company: person.company || partners[0].trade_name || '',
          job_title: person.job_title || '',
          bio: person.bio || '',
          linkedin: person.linkedin || '',
          photo_url: person.photo_url || '',
          role_in_event: 'partner_rep',
          registration_status: 'confirmed',
          person_id: rep.person_id,
          is_deleted: false,
          created_day: new Date().toISOString().slice(0, 10),
        });
        participantsCreated += 1;
      }
    }

    return Response.json({
      ok: true,
      event_partner_id: eventPartner.id,
      participants_created: participantsCreated,
    });
  } catch (error: any) {
    console.error('associateEventPartner error:', error?.message || error);
    return Response.json({ error: 'Não foi possível concluir a operação.' }, { status: 500 });
  }
}