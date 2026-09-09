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