import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import {
  canAccessEventData,
  canAccessPartnerData,
  verifyEventMembership,
  EVENT_MANAGER_ROLES,
  resolveUserPersonId,
} from "../../shared/eventAuth.ts";

// Leitura de Participants com verificação server-side (endurecimento de PII).
// O SDK direto ficou restrito ao registro próprio (por e-mail) ou admin; TODA
// leitura de terceiros passa por aqui, sempre em escopo por evento:
//
//   op 'event'     → participantes de UM evento. Gate: admin, EventMembership
//                    ativa OU registro próprio ativo no evento
//                    (canAccessEventData). CPF só para admin/gestão
//                    (manager/team) — PII sensível não vaza para participantes.
//   op 'my'        → registros próprios (e-mail OU person_id), com CPF.
//   op 'my_events' → participantes de todos os eventos onde o chamador tem
//                    registro próprio ATIVO (ranking geral, descoberta da
//                    Rede global). CPF removido; paginação limit/skip.
//   op 'partner_speakers' → participantes speaker dos reps ativos de um
//                    parceiro (painéis do parceiro). Gate: canAccessPartnerData.
//                    CPF removido.
//   op 'import_lookup' → campos mínimos de TODOS os participantes para dedup
//                    da importação CSV (id, event_id, email, cpf, person_id).
//                    Gate: admin OU manager/team do evento.

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 2000;

function stripCpf(p: any) {
  if (!p) return p;
  const out = { ...p };
  delete out.cpf;
  return out;
}

// Registros próprios do chamador (e-mail OU person_id), deduplicados por id.
async function fetchOwnParticipants(base44: any, svc: any, user: any): Promise<any[]> {
  const personId = await resolveUserPersonId(base44, user);
  const queries: any[] = [svc.entities.Participant.filter({ email: user.email, is_deleted: false })];
  if (personId) queries.push(svc.entities.Participant.filter({ person_id: personId, is_deleted: false }));
  const [byEmail, byPerson] = await Promise.all(queries);
  const seen = new Map<string, any>();
  const merged = [...(byEmail || []), ...(byPerson || [])];
  for (let i = 0; i < merged.length; i++) {
    if (!seen.has(merged[i].id)) seen.set(merged[i].id, merged[i]);
  }
  return Array.from(seen.values());
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const op = String(body.op || "event");

    // ===== Registros próprios (e-mail OU person_id) — CPF incluído =====
    if (op === "my") {
      const own = await fetchOwnParticipants(base44, svc, user);
      return Response.json({ participants: own });
    }

    // ===== Participantes dos eventos com registro próprio ATIVO =====
    if (op === "my_events") {
      const limit = Math.min(Math.max(Number(body.limit) || MAX_LIMIT, 1), MAX_LIMIT);
      const skip = Math.max(Number(body.skip) || 0, 0);
      const own = await fetchOwnParticipants(base44, svc, user);
      const eventIds = new Set<string>();
      for (let i = 0; i < own.length; i++) {
        if (own[i].event_id && own[i].registration_status !== "cancelled") eventIds.add(own[i].event_id);
      }
      if (eventIds.size === 0) return Response.json({ participants: [], has_more: false });
      const page = await svc.entities.Participant.filter(
        { event_id: { $in: Array.from(eventIds) }, is_deleted: false },
        "id",
        limit,
        skip
      );
      const out: any[] = [];
      for (let i = 0; i < page.length; i++) out.push(stripCpf(page[i]));
      return Response.json({ participants: out, has_more: page.length >= limit });
    }

    // ===== Participantes de UM evento (escopo por evento) =====
    if (op === "event") {
      const eventId = String(body.event_id || "");
      if (!eventId) return Response.json({ error: "event_id obrigatório." }, { status: 400 });
      const allowed = await canAccessEventData(base44, user, eventId);
      if (!allowed) {
        return Response.json({ error: "Você não participa deste evento." }, { status: 403 });
      }
      const query: any = { event_id: eventId, is_deleted: false };
      if (body.role_in_event) query.role_in_event = String(body.role_in_event);
      if (Array.isArray(body.participant_ids) && body.participant_ids.length > 0) {
        query.id = { $in: body.participant_ids.map(String) };
      }
      if (body.eligible_only === true) query.is_eligible = { $ne: false };
      const limit = Math.min(Math.max(Number(body.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
      const skip = Math.max(Number(body.skip) || 0, 0);
      const participants = await svc.entities.Participant.filter(query, "-created_date", limit, skip);
      // CPF é PII sensível: visível apenas para admin OU gestão do evento.
      let isManagement = user.role === "admin";
      if (!isManagement) {
        const mgr = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
        isManagement = mgr.authorized;
      }
      const out: any[] = [];
      for (let i = 0; i < participants.length; i++) out.push(isManagement ? participants[i] : stripCpf(participants[i]));
      return Response.json({ participants: out, has_more: participants.length >= limit });
    }

    // ===== Speakers dos reps ativos de um parceiro =====
    if (op === "partner_speakers") {
      const partnerId = String(body.partner_id || "");
      if (!partnerId) return Response.json({ error: "partner_id obrigatório." }, { status: 400 });
      const allowed = await canAccessPartnerData(base44, user, partnerId);
      if (!allowed) return Response.json({ error: "Sem permissão sobre este parceiro." }, { status: 403 });
      const reps = await svc.entities.PartnerRepresentative.filter({ partner_id: partnerId, is_active: true, is_deleted: false });
      const personIds: string[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < reps.length; i++) {
        const pid = reps[i].person_id;
        if (pid && !seen.has(pid)) { seen.add(pid); personIds.push(pid); }
      }
      if (personIds.length === 0) return Response.json({ participants: [] });
      const participants = await svc.entities.Participant.filter({ role_in_event: "speaker", person_id: { $in: personIds }, is_deleted: false });
      const out: any[] = [];
      for (let i = 0; i < participants.length; i++) out.push(stripCpf(participants[i]));
      return Response.json({ participants: out });
    }

    // ===== Lookup global para dedup da importação CSV (campos mínimos) =====
    if (op === "import_lookup") {
      const eventId = String(body.event_id || "");
      if (!eventId) return Response.json({ error: "event_id obrigatório." }, { status: 400 });
      const mgr = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
      if (!mgr.authorized) return Response.json({ error: "Sem permissão." }, { status: 403 });
      const all = await svc.entities.Participant.filter({ is_deleted: false });
      const out: any[] = [];
      for (let i = 0; i < all.length; i++) {
        out.push({
          id: all[i].id,
          event_id: all[i].event_id,
          email: all[i].email || "",
          cpf: all[i].cpf || "",
          person_id: all[i].person_id || "",
        });
      }
      return Response.json({ participants: out });
    }

    return Response.json({ error: "Operação desconhecida." }, { status: 400 });
  } catch (error: any) {
    console.error("[getEventParticipants]", error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}