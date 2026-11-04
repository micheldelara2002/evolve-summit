import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { normalizeEmail } from "../../shared/identity.ts";
import { grantEventRole } from "../../shared/eventInvites.ts";

// 2026-11-04 — SOLICITAÇÃO DE EVENTO.
// Cada evento é uma fonte de receita, então manager NÃO cria evento: solicita.
// Só a aprovação do admin cria o Event (idempotente: uma solicitação gera no
// máximo um evento) e concede o vínculo de gerente a quem solicitou.

const MAX_PENDING_PER_USER = 5;

function cleanText(value: any, max = 400) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

async function writeAudit(svc: any, user: any, request: any, details: any, eventId?: string) {
  try {
    await svc.entities.AuditLog.create({
      event_id: eventId || '',
      action: 'status_change',
      entity_type: 'EventRequest',
      entity_id: request.id,
      user_id: user.id,
      user_name: user.full_name || '',
      details: JSON.stringify(details),
    });
  } catch { /* trilha auxiliar (não financeira) */ }
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;
    const isAdmin = user.role === 'admin';

    const body = await req.json().catch(() => ({}));
    const { action = 'list', requestId, data = {} } = body;

    // ── LIST ───────────────────────────────────────────────────────────────
    if (action === 'list') {
      const filter: any = { is_deleted: false };
      if (!isAdmin) filter.requested_by_user_id = user.id;
      if (body.status) filter.status = body.status;
      const requests = await svc.entities.EventRequest.filter(filter, { sort: '-created_date', limit: 100 });
      const list = Array.isArray(requests) ? requests : (requests?.items || []);
      return Response.json({ requests: list });
    }

    // ── CREATE (qualquer usuário ativo solicita) ───────────────────────────
    if (action === 'create') {
      const name = cleanText(data.name, 140);
      const startDate = data.start_date ? new Date(data.start_date) : null;
      const endDate = data.end_date ? new Date(data.end_date) : null;
      if (!name || name.length < 3) {
        return Response.json({ error: 'Informe o nome do evento.' }, { status: 400 });
      }
      if (!startDate || Number.isNaN(startDate.getTime())) {
        return Response.json({ error: 'Informe a data de início.' }, { status: 400 });
      }
      if (endDate && endDate < startDate) {
        return Response.json({ error: 'A data de término não pode ser anterior ao início.' }, { status: 400 });
      }

      const pending = await svc.entities.EventRequest.filter({
        requested_by_user_id: user.id,
        status: 'pending',
        is_deleted: false,
      });
      if (pending.length >= MAX_PENDING_PER_USER) {
        return Response.json({
          error: `Você já tem ${MAX_PENDING_PER_USER} solicitações aguardando análise. Aguarde a decisão do administrador.`,
        }, { status: 429 });
      }

      const managerEmail = normalizeEmail(data.manager_email || user.email);
      const created = await svc.entities.EventRequest.create({
        requested_by_user_id: user.id,
        requested_by_name: user.full_name || '',
        requested_by_email: normalizeEmail(user.email),
        name,
        description: cleanText(data.description, 2000),
        start_date: startDate.toISOString(),
        end_date: endDate ? endDate.toISOString() : '',
        location: cleanText(data.location, 200),
        expected_participants: data.expected_participants ? Number(data.expected_participants) : null,
        manager_email: managerEmail,
        notes: cleanText(data.notes, 1000),
        status: 'pending',
        is_deleted: false,
      });
      await writeAudit(svc, user, created, { decision: 'requested', name });
      return Response.json({ request: created });
    }

    if (!requestId) return Response.json({ error: 'requestId é obrigatório.' }, { status: 400 });

    const rows = await svc.entities.EventRequest.filter({ id: requestId, is_deleted: false });
    const request = rows?.[0];
    if (!request) return Response.json({ error: 'Solicitação não encontrada.' }, { status: 404 });

    // ── CANCEL (solicitante, enquanto pendente) ────────────────────────────
    if (action === 'cancel') {
      if (request.requested_by_user_id !== user.id) {
        return Response.json({ error: 'Somente quem solicitou pode cancelar.' }, { status: 403 });
      }
      if (request.status !== 'pending') {
        return Response.json({ error: 'Esta solicitação já foi analisada.' }, { status: 409 });
      }
      const updated = await svc.entities.EventRequest.update(request.id, {
        status: 'canceled',
        reviewed_at: new Date().toISOString(),
      });
      return Response.json({ request: updated });
    }

    if (!isAdmin) return Response.json({ error: 'Apenas administradores analisam solicitações.' }, { status: 403 });

    // ── REJECT ─────────────────────────────────────────────────────────────
    if (action === 'reject') {
      if (request.status !== 'pending') {
        return Response.json({ error: 'Esta solicitação já foi analisada.' }, { status: 409 });
      }
      const updated = await svc.entities.EventRequest.update(request.id, {
        status: 'rejected',
        review_notes: cleanText(body.notes, 1000),
        reviewed_by_user_id: user.id,
        reviewed_by_name: user.full_name || '',
        reviewed_at: new Date().toISOString(),
      });
      await writeAudit(svc, user, request, { decision: 'rejected', notes: cleanText(body.notes, 300) });
      return Response.json({ request: updated });
    }

    // ── APPROVE (única porta que cria o Event) ─────────────────────────────
    if (action === 'approve') {
      if (request.status === 'approved' && request.created_event_id) {
        return Response.json({ request, event_id: request.created_event_id, idempotent: true });
      }
      if (request.status !== 'pending') {
        return Response.json({ error: 'Esta solicitação já foi analisada.' }, { status: 409 });
      }

      const status = ['draft', 'active'].includes(body.eventStatus) ? body.eventStatus : 'draft';
      const event = await svc.entities.Event.create({
        name: request.name,
        description: request.description || '',
        start_date: request.start_date,
        end_date: request.end_date || request.start_date,
        location: request.location || '',
        status,
        max_participants: request.expected_participants || undefined,
        is_deleted: false,
      });

      await Promise.all([
        svc.entities.Track.create({ event_id: event.id, name: 'Principal', color: '#4F46E5', is_deleted: false }),
        svc.entities.Room.create({ event_id: event.id, name: 'Plenária', is_deleted: false }),
      ]);

      // Quem solicitou (ou o e-mail de gestão indicado) recebe o vínculo.
      const managerEmail = normalizeEmail(request.manager_email || request.requested_by_email || '');
      try {
        await grantEventRole(base44, {
          eventId: event.id,
          email: managerEmail,
          displayName: request.requested_by_name,
          role: 'manager',
          actor: user,
        });
      } catch (error: any) {
        console.error('manageEventRequest: manager grant failed', error?.message || error);
      }

      const updated = await svc.entities.EventRequest.update(request.id, {
        status: 'approved',
        review_notes: cleanText(body.notes, 1000),
        reviewed_by_user_id: user.id,
        reviewed_by_name: user.full_name || '',
        reviewed_at: new Date().toISOString(),
        created_event_id: event.id,
      });
      await writeAudit(svc, user, request, { decision: 'approved', event_id: event.id }, event.id);

      return Response.json({ request: updated, event_id: event.id });
    }

    return Response.json({ error: 'Ação não suportada.' }, { status: 400 });
  } catch (error: any) {
    console.error('manageEventRequest error:', error?.message || error);
    return Response.json({ error: 'Não foi possível concluir a operação.' }, { status: 500 });
  }
}