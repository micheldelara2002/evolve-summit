// P0.3 — Helpers de manutenção dos counters materializados (EventStats/MetricBucket).
// Best-effort: a mutation principal já sucedeu; falha aqui NÃO bloqueia e NÃO avisa —
// a reconciliação (reconcileBusinessMetrics / reconcileGlobalMetrics) corrige qualquer drift.
import { base44 } from "@/api/base44Client";

export async function incParticipantCounter(eventId, createdDateISO, role) {
  if (!eventId || !createdDateISO) return;
  try {
    await base44.functions.invoke("maintainBusinessCounter", { action: "incParticipant", eventId, createdDateISO, role });
  } catch {}
}

export async function decParticipantCounter(eventId, createdDateISO, role) {
  if (!eventId || !createdDateISO) return;
  try {
    await base44.functions.invoke("maintainBusinessCounter", { action: "decParticipant", eventId, createdDateISO, role });
  } catch {}
}

export async function bulkIncParticipantsCounter(eventId, createdDates, roles) {
  if (!eventId || !Array.isArray(createdDates) || createdDates.length === 0) return;
  try {
    await base44.functions.invoke("maintainBusinessCounter", { action: "bulkIncParticipants", eventId, createdDates, roles });
  } catch {}
}

export async function moveParticipantRoleCounter(eventId, createdDateISO, oldRole, newRole) {
  if (!eventId || !createdDateISO) return;
  try {
    await base44.functions.invoke("maintainBusinessCounter", { action: "moveParticipantRole", eventId, createdDateISO, oldRole, newRole });
  } catch {}
}

export async function incLeadsCounter(eventId, createdDateISO, partnerId) {
  if (!eventId || !createdDateISO) return;
  try {
    await base44.functions.invoke("maintainBusinessCounter", { action: "incLeads", eventId, partnerId, createdDateISO });
  } catch {}
}

export async function incPersonsCounter(createdDateISO) {
  if (!createdDateISO) return;
  try {
    await base44.functions.invoke("maintainBusinessCounter", { action: "incPersons", createdDateISO });
  } catch {}
}

export async function incPartnersCounter(createdDateISO) {
  if (!createdDateISO) return;
  try {
    await base44.functions.invoke("maintainBusinessCounter", { action: "incPartners", createdDateISO });
  } catch {}
}

export async function decPartnersCounter(createdDateISO) {
  if (!createdDateISO) return;
  try {
    await base44.functions.invoke("maintainBusinessCounter", { action: "decPartners", createdDateISO });
  } catch {}
}