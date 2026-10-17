/**
 * Lote 4 — Frontend service for hardened entities (Person, Lead, SessionAttendance,
 * SessionReview). All direct SDK access to these entities goes through validated
 * backend functions. Never import base44.entities.Person directly.
 */
import { base44 } from "@/api/base44Client";

async function invoke(name, payload) {
  const res = await base44.functions.invoke(name, payload);
  return res.data;
}

/** Own person of the authenticated user (or null). */
export async function fetchMyPerson() {
  const data = await invoke("getMyPerson", {});
  return data?.person ?? null;
}

/** Create-or-update own person profile. Returns the saved person. */
export async function saveMyPerson(data) {
  const out = await invoke("saveMyPerson", { data });
  return out?.person ?? null;
}

/**
 * Persons by IDs. Non-admin callers must pass eventIds they can access;
 * only persons linked to participants of those events are returned.
 */
export async function fetchPersonsByIds(eventIds, personIds) {
  const ids = (Array.isArray(personIds) ? personIds : []).filter(Boolean);
  if (!ids.length) return [];
  const evIds = (Array.isArray(eventIds) ? eventIds : []).filter(Boolean);
  const data = await invoke("getPersonsByIds", { eventIds: evIds, personIds: ids });
  return data?.persons || [];
}

/** Person search for the People module (admin global, managers event-scoped). */
export async function searchPersons(eventId, query = "") {
  const data = await invoke("managePerson", { op: "search", eventId, query: String(query || "") });
  return data?.persons || [];
}

/** Admin/manager person create-or-update. Returns the saved person. */
export async function saveManagedPerson({ eventId, personId, data }) {
  const out = await invoke("managePerson", { op: "save", eventId, personId, data });
  return out?.person ?? null;
}

/** Booth visit lead (source=booth_scan). Returns the created lead. */
export async function saveBoothLead({ eventId, partnerId, participantId, personId }) {
  const out = await invoke("saveBoothLead", { eventId, partnerId, participantId, personId });
  return out?.lead ?? null;
}

/** Session attendance: action = "status" | "register" | "unregister". */
export async function manageAttendance({ sessionId, participantId, action }) {
  const data = await invoke("manageSessionAttendance", { sessionId, participantId, action });
  return data || {};
}

/** Speaker's own session feedback (reviews + attendances). */
export async function fetchSpeakerFeedback(sessionIds) {
  const ids = (Array.isArray(sessionIds) ? sessionIds : []).filter(Boolean);
  if (!ids.length) return { sessionIds: [], reviews: [], attendances: [] };
  const data = await invoke("getSpeakerSessionFeedback", { sessionIds: ids });
  return {
    sessionIds: data?.sessionIds || [],
    reviews: data?.reviews || [],
    attendances: data?.attendances || [],
  };
}

/** Partner's leads for an event (partner-gated read).
 *  P0 (2026-10-17) — Paginação por cursor: o endpoint devolve no máximo 200
 *  por chamada; casos que precisam do pool completo (ex.: sorteio) percorrem
 *  as páginas com o cursor devolvido — nunca um limite gigante numa resposta. */
export async function fetchPartnerLeads(partnerId, eventId) {
  const all = [];
  let cursor;
  let hasMore = true;
  while (hasMore) {
    const data = await invoke("getMyLeads", { partnerId, eventId, limit: 200, cursor });
    all.push(...(data?.leads || []));
    cursor = data?.next_cursor || null;
    hasMore = !!data?.has_more && !!cursor;
  }
  return all;
}

/** Participant's own session review: action "get" | "save". */
export async function manageSessionReview({ sessionId, action, rating, comment }) {
  return invoke("saveSessionReview", { sessionId, action, rating, comment });
}

/** Create-or-get own person id (signup/CFP flows). Returns person_id. */
export async function getOrCreateMyPerson() {
  const data = await invoke("getOrCreatePerson", {});
  return data?.person_id || null;
}