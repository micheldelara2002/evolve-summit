import { base44 } from "@/api/base44Client";
import { scanPagedEndpoint } from "@/lib/fetchAll";

/**
 * participantApi — porta única de escrita de Participant (e acessos de apoio do
 * módulo Pessoas: Session, EventMembership reviewer, PersonDocument, Import).
 * A função manageParticipant valida no servidor: admin OU EventMembership ativa
 * manager/team no evento. O SDK direto permanece travado por RLS (Lote 3).
 */
async function invokeOp(payload) {
  const res = await base44.functions.invoke("manageParticipant", payload);
  return res.data;
}

/**
 * Cadastro de participante. O servidor resolve a Person pelo e-mail e, quando
 * a pessoa ainda não tem conta, dispara o convite de cadastro:
 *   { participant, account_linked, invite: { status: 'sent'|'failed', error } }
 */
export async function createParticipant(eventId, data) {
  const out = await invokeOp({ op: "create", event_id: eventId, data });
  return {
    participant: out.participant,
    account_linked: !!out.account_linked,
    invite: out.invite || null,
  };
}

export async function bulkCreateParticipants(eventId, items) {
  const out = await invokeOp({ op: "bulkCreate", event_id: eventId, items });
  // duplicates: bloqueados pela política de dedup (1 e-mail ativo = 1 inscrição).
  // invites/failed_invites: convites de cadastro enviados (e os que falharam).
  return {
    participants: out.participants || [],
    duplicates: out.duplicates || [],
    accounts_linked: out.accounts_linked || 0,
    invites: out.invites || { sent: 0, failed: 0 },
    failed_invites: out.failed_invites || [],
  };
}

// ── Equipe do evento (staff) ────────────────────────────────────────────────
// Só admin ou o GERENTE do evento: o servidor recusa 'team' nesses comandos.
export async function getEventStaff(eventId) {
  const out = await invokeOp({ op: "listStaff", event_id: eventId });
  return {
    memberships: out.memberships || [],
    invites: out.invites || [],
    participants: out.participants || [],
  };
}

export async function assignEventStaff(eventId, { email, full_name }) {
  const out = await invokeOp({ op: "assignStaff", event_id: eventId, email, full_name });
  return out;
}

export async function removeEventStaff(eventId, { participantId, email }) {
  return invokeOp({ op: "removeStaff", event_id: eventId, participant_id: participantId || "", email: email || "" });
}

export async function updateParticipant(eventId, participantId, data) {
  const out = await invokeOp({ op: "update", event_id: eventId, participant_id: participantId, data });
  return out.participant;
}

export async function softDeleteParticipant(eventId, participantId) {
  return invokeOp({ op: "softDelete", event_id: eventId, participant_id: participantId });
}

export async function getEventSessions(eventId) {
  const out = await invokeOp({ op: "getSessions", event_id: eventId });
  return out.sessions || [];
}

export async function getEventReviewers(eventId) {
  const out = await invokeOp({ op: "getReviewers", event_id: eventId });
  return out.reviewers || [];
}

export async function getReviewerMembership(eventId, personId) {
  const out = await invokeOp({ op: "getReviewer", event_id: eventId, person_id: personId });
  return { membership: out.membership || null, linked_user_id: out.linked_user_id || "" };
}

export async function setReviewerMembership(eventId, payload) {
  return invokeOp({ op: "setReviewer", event_id: eventId, ...payload });
}

export async function findPersonIdsByDocument(eventId, digits) {
  const out = await invokeOp({ op: "findPersonsByDocument", event_id: eventId, digits });
  return { person_ids: out.person_ids || [] };
}

export async function createEventImport(eventId, fileName, totalRows) {
  const out = await invokeOp({ op: "importCreate", event_id: eventId, file_name: fileName, total_rows: totalRows });
  return out.import;
}

export async function updateEventImport(eventId, importId, data) {
  return invokeOp({ op: "importUpdate", event_id: eventId, import_id: importId, data });
}

/**
 * Leituras de Participant (endurecimento de PII): o SDK direto só devolve o
 * registro próprio (por e-mail) ou admin. Listas de terceiros passam pela
 * função getEventParticipants, que valida vínculo com o evento e remove CPF
 * de quem não é gestão.
 */
async function invokeRead(payload) {
  const res = await base44.functions.invoke("getEventParticipants", payload);
  return res.data;
}

export async function fetchMyParticipants() {
  const out = await invokeRead({ op: "my" });
  return out.participants || [];
}

export async function fetchEventParticipants(eventId, opts = {}) {
  const out = await invokeRead({ op: "event", event_id: eventId, ...opts });
  return out.participants || [];
}

/**
 * TODOS os participantes do evento, em páginas encadeadas (limit+skip).
 * P2 (auditoria 2026-09-28) — sem isso a chamada única trunca silenciosamente
 * no limite do backend (1.000) e a gestão não vê o resto da lista.
 */
export async function fetchAllEventParticipants(eventId) {
  // MAX_LIMIT do backend = 2000; scanPagedEndpoint encadeia has_more até esgotar.
  return scanPagedEndpoint((skip) =>
    invokeRead({ op: "event", event_id: eventId, limit: 2000, skip }).then((out) => ({
      page: out.participants || [],
      hasMore: !!out.has_more,
    }))
  );
}

export async function fetchMyEventsParticipantsPage({ limit, skip } = {}) {
  const out = await invokeRead({ op: "my_events", limit, skip });
  return { participants: out.participants || [], hasMore: !!out.has_more };
}

export async function fetchAllMyEventsParticipants() {
  return scanPagedEndpoint((skip) =>
    fetchMyEventsParticipantsPage({ limit: 2000, skip }).then(({ participants, hasMore }) => ({
      page: participants,
      hasMore,
    }))
  );
}

export async function fetchPartnerSpeakerParticipants(partnerId) {
  const out = await invokeRead({ op: "partner_speakers", partner_id: partnerId });
  return out.participants || [];
}

export async function fetchGlobalParticipantLookup(eventId) {
  const out = await invokeRead({ op: "import_lookup", event_id: eventId });
  // complete: varredura cobriu TODOS os participantes do evento (sem truncagem).
  return { participants: out.participants || [], complete: out.complete !== false };
}