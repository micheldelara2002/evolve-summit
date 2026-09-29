// Utility functions for the Business Dashboard.
// P3 (2026-09-29) — exports mortos removidos (getPeriodRange, getPreviousRange,
// inRange, pctChange, getBucketKey, formatBucketLabel, getBucketType — nunca
// importados; a lógica de período equivalente vive em base44/shared/
// businessPeriod.ts, no backend). Apenas formatDateTime é usada (BusinessDashboard).

export function formatDateTime(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}