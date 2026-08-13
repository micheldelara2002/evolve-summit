// P0.3 — Helpers de manutenção dos counters materializados (EventStats/MetricBucket).
// Best-effort: a mutation principal já sucedeu; falha aqui NÃO bloqueia e NÃO avisa —
// a reconciliação (reconcileBusinessMetrics) corrige qualquer drift.
import { base44 } from "@/api/base44Client";

export async function incParticipantCounter(eventId, createdDateISO) {
  if (!eventId || !createdDateISO) return;
  try {
    await base44.functions.invoke("maintainBusinessCounter", { action: "incParticipant", eventId, createdDateISO });
  } catch {}
}

export async function decParticipantCounter(eventId, createdDateISO) {
  if (!eventId || !createdDateISO) return;
  try {
    await base44.functions.invoke("maintainBusinessCounter", { action: "decParticipant", eventId, createdDateISO });
  } catch {}
}

export async function incLeadsCounter(eventId, createdDateISO, partnerId) {
  if (!eventId || !createdDateISO) return;
  try {
    await base44.functions.invoke("maintainBusinessCounter", { action: "incLeads", eventId, partnerId, createdDateISO });
  } catch {}
}

export async function bulkIncParticipantsCounter(eventId, createdDates) {
  if (!eventId || !Array.isArray(createdDates) || createdDates.length === 0) return;
  try {
    await base44.functions.invoke("maintainBusinessCounter", { action: "bulkIncParticipants", eventId, createdDates });
  } catch {}
}