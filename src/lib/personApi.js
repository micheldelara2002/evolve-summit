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

/** Persons list for the partner representatives dialog. */
export async function listPartnerPersons(partnerId) {
  const data = await invoke("getPartnerPersons", { partnerId });
  return data?.persons || [];
}