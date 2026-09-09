// manageParticipant — porta única de escrita do módulo Pessoas (Lote 3.1).
// Valida no servidor: admin OU EventMembership ativa manager/team no evento
// (verifyEventMembership). Todas as escritas de Participant — e os acessos a
// entidades de apoio travadas por RLS (Session read, EventMembership reviewer,
// PersonDocument, Import) — passam por aqui com service role.
// Contadores (maintainBusinessCounter) e auditoria (logAuditEvent) seguem no
// frontend, best-effort como hoje; a função apenas grava o registro.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

const WRITABLE_FIELDS = [
  'full_name', 'email', 'cpf', 'phone', 'company', 'job_title',
  'linkedin', 'instagram', 'youtube', 'website', 'bio',
  'role_in_event', 'registration_status', 'person_id', 'import_id',
  'checkin_status', 'checkin_at', 'checked_in_by_user_id', 'created_day',
];
const ROLE_ENUM = ['attendee', 'speaker', 'team', 'manager', 'partner_rep'];

function pickFields(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const key of WRITABLE_FIELDS) {
    if (key in data) out[key] = data[key];
  }
  return out;
}

function normDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

async function speakerHasSessions(base44, eventId, participantId) {
  const sessions = await base44.asServiceRole.entities.Session.filter({
    event_id: eventId,
    speaker_id: participantId,
    is_deleted: false,
  });
  return sessions.length > 0;
}

async function resolveUserIdByEmail(base44, email) {
  if (!email) return '';
  try {
    const users = await base44.asServiceRole.entities.User.filter({ email: String(email).trim().toLowerCase() });
    return users?.[0]?.id || '';
  } catch (e) {
    return '';
  }
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Não autenticado.' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const op = String(body.op || '');
    const eventId = String(body.event_id || '');
    if (!op) return Response.json({ error: 'Operação ausente.' }, { status: 400 });
    if (!eventId) return Response.json({ error: 'event_id ausente.' }, { status: 400 });

    // Gate: admin OU membership ativa manager/team neste evento
    const { authorized } = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
    if (!authorized) {
      return Response.json({ error: 'Sem permissão para gerenciar participantes deste evento.' }, { status: 403 });
    }

    if (op === 'create') {
      const data = pickFields(body.data);
      if (!data.full_name) return Response.json({ error: 'Nome é obrigatório.' }, { status: 400 });
      if (data.role_in_event && !ROLE_ENUM.includes(data.role_in_event)) {
        return Response.json({ error: 'Papel inválido.' }, { status: 400 });
      }
      const created = await base44.asServiceRole.entities.Participant.create({ ...data, event_id: eventId });
      return Response.json({ participant: created });
    }

    if (op === 'bulkCreate') {
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) return Response.json({ error: 'Nenhum registro para criar.' }, { status: 400 });
      if (items.length > 200) return Response.json({ error: 'Lote maior que 200 registros.' }, { status: 400 });
      const payloads = items.map((it) => ({ ...pickFields(it), event_id: eventId }));
      const created = await base44.asServiceRole.entities.Participant.bulkCreate(payloads);
      return Response.json({ participants: created });
    }

    if (op === 'update') {
      const participantId = String(body.participant_id || '');
      const data = pickFields(body.data);
      if (!participantId) return Response.json({ error: 'participant_id ausente.' }, { status: 400 });
      if (data.role_in_event && !ROLE_ENUM.includes(data.role_in_event)) {
        return Response.json({ error: 'Papel inválido.' }, { status: 400 });
      }
      const found = await base44.asServiceRole.entities.Participant.filter({ id: participantId, event_id: eventId });
      if (!found.length) return Response.json({ error: 'Participante não encontrado neste evento.' }, { status: 404 });
      const current = found[0];
      if (data.role_in_event && current.role_in_event === 'speaker' && data.role_in_event !== 'speaker') {
        if (await speakerHasSessions(base44, eventId, participantId)) {
          return Response.json({ error: 'Não é possível alterar o papel: esta pessoa possui sessão associada. Edite a sessão primeiro.' }, { status: 409 });
        }
      }
      const updated = await base44.asServiceRole.entities.Participant.update(participantId, data);
      return Response.json({ participant: updated });
    }

    if (op === 'softDelete') {
      const participantId = String(body.participant_id || '');
      if (!participantId) return Response.json({ error: 'participant_id ausente.' }, { status: 400 });
      const found = await base44.asServiceRole.entities.Participant.filter({ id: participantId, event_id: eventId });
      if (!found.length) return Response.json({ error: 'Participante não encontrado neste evento.' }, { status: 404 });
      if (await speakerHasSessions(base44, eventId, participantId)) {
        return Response.json({ error: 'Não é possível remover: existe sessão associada a esta pessoa.' }, { status: 409 });
      }
      await base44.asServiceRole.entities.Participant.update(participantId, { is_deleted: true });
      return Response.json({ ok: true });
    }

    if (op === 'getSessions') {
      const sessions = await base44.asServiceRole.entities.Session.filter({ event_id: eventId, is_deleted: false });
      return Response.json({ sessions: sessions.map((s) => ({ id: s.id, title: s.title, speaker_id: s.speaker_id })) });
    }

    if (op === 'getReviewers') {
      const memberships = await base44.asServiceRole.entities.EventMembership.filter({
        event_id: eventId,
        role: 'reviewer',
        is_active: true,
        is_deleted: false,
      });
      return Response.json({ reviewers: memberships });
    }

    if (op === 'getReviewer') {
      const personId = String(body.person_id || '');
      if (!personId) return Response.json({ error: 'person_id ausente.' }, { status: 400 });
      const memberships = await base44.asServiceRole.entities.EventMembership.filter({
        event_id: eventId,
        person_id: personId,
        role: 'reviewer',
        is_deleted: false,
      });
      const membership = memberships[0] || null;
      const linkedUserId = (membership?.user_id) || (membership ? await resolveUserIdByEmail(base44, membership.user_email) : '');
      return Response.json({ membership, linked_user_id: linkedUserId });
    }

    if (op === 'setReviewer') {
      const personId = String(body.person_id || '');
      const enable = body.enable === true;
      const membershipId = String(body.membership_id || '');
      if (!personId) return Response.json({ error: 'person_id ausente.' }, { status: 400 });
      if (enable) {
        let userId = String(body.user_id || '');
        if (!userId) userId = await resolveUserIdByEmail(base44, body.user_email);
        if (membershipId) {
          await base44.asServiceRole.entities.EventMembership.update(membershipId, {
            is_deleted: false,
            is_active: true,
            user_id: userId,
          });
        } else {
          await base44.asServiceRole.entities.EventMembership.create({
            event_id: eventId,
            person_id: personId,
            person_name: String(body.person_name || ''),
            user_id: userId,
            user_email: String(body.user_email || ''),
            role: 'reviewer',
            is_active: true,
          });
        }
        return Response.json({ ok: true });
      }
      if (!membershipId) return Response.json({ error: 'membership_id ausente para desativar avaliador.' }, { status: 400 });
      await base44.asServiceRole.entities.EventMembership.update(membershipId, { is_deleted: true });
      return Response.json({ ok: true });
    }

    if (op === 'findPersonsByDocument') {
      const digits = normDigits(body.digits);
      if (digits.length < 3) return Response.json({ person_ids: [] });
      const docs = await base44.asServiceRole.entities.PersonDocument.filter({ status: 'active' });
      const ids = [...new Set(
        docs.filter((d) => normDigits(d.document_number).includes(digits)).map((d) => d.person_id)
      )];
      return Response.json({ person_ids: ids.slice(0, 100) });
    }

    if (op === 'importCreate') {
      const fileName = String(body.file_name || '').slice(0, 200);
      if (!fileName) return Response.json({ error: 'file_name ausente.' }, { status: 400 });
      const record = await base44.asServiceRole.entities.Import.create({
        event_id: eventId,
        file_name: fileName,
        status: 'processing',
        total_rows: Number(body.total_rows) || 0,
      });
      return Response.json({ import: record });
    }

    if (op === 'importUpdate') {
      const importId = String(body.import_id || '');
      if (!importId) return Response.json({ error: 'import_id ausente.' }, { status: 400 });
      const found = await base44.asServiceRole.entities.Import.filter({ id: importId, event_id: eventId });
      if (!found.length) return Response.json({ error: 'Importação não encontrada.' }, { status: 404 });
      const src = body.data || {};
      const data = {};
      for (const key of ['status', 'success_count', 'error_count', 'duplicate_count', 'errors_detail']) {
        if (key in src) data[key] = src[key];
      }
      await base44.asServiceRole.entities.Import.update(importId, {
        status: data.status,
        success_count: data.success_count,
        error_count: data.error_count,
        duplicate_count: data.duplicate_count,
        errors_detail: data.errors_detail,
      });
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Operação desconhecida: ' + op }, { status: 400 });
  } catch (error) {
    console.error('manageParticipant error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}