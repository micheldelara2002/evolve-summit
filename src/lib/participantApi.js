import { base44 } from "@/api/base44Client";

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

export async function createParticipant(eventId, data) {
  const out = await invokeOp({ op: "create", event_id: eventId, data });
  return out.participant;
}

export async function bulkCreateParticipants(eventId, items) {
  const out = await invokeOp({ op: "bulkCreate", event_id: eventId, items });
  return out.participants || [];
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

export async function fetchMyEventsParticipantsPage({ limit, skip } = {}) {
  const out = await invokeRead({ op: "my_events", limit, skip });
  return { participants: out.participants || [], hasMore: !!out.has_more };
}

export async function fetchAllMyEventsParticipants() {
  const BATCH = 2000;
  const all = [];
  let skip = 0;
  while (true) {
    const { participants, hasMore } = await fetchMyEventsParticipantsPage({ limit: BATCH, skip });
    all.push(...participants);
    if (!hasMore || participants.length === 0) break;
    skip += BATCH;
  }
  return all;
}

export async function fetchPartnerSpeakerParticipants(partnerId) {
  const out = await invokeRead({ op: "partner_speakers", partner_id: partnerId });
  return out.participants || [];
}

export async function fetchGlobalParticipantLookup(eventId) {
  const out = await invokeRead({ op: "import_lookup", event_id: eventId });
  return out.participants || [];
}