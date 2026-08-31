// Helpers de período/delta compartilhados entre getBusinessDashboardMetrics e
// getSalesMetrics (e qualquer agregador temporal). Módulo puro, sem Deno.serve.

export function getPeriodRange(period, customStart, customEnd) {
  const now = new Date();
  const end = new Date(now);
  let start = new Date(now);
  switch (period) {
    case "7d": start.setDate(start.getDate() - 7); break;
    case "1m": start.setMonth(start.getMonth() - 1); break;
    case "3m": start.setMonth(start.getMonth() - 3); break;
    case "6m": start.setMonth(start.getMonth() - 6); break;
    case "1y": start.setFullYear(start.getFullYear() - 1); break;
    case "custom":
      // Aceita date-only (snap meia-noite / fim-do-dia) OU ISO datetime (precisão de minuto).
      if (customStart) start = customStart.includes("T") ? new Date(customStart) : new Date(customStart + "T00:00:00");
      if (customEnd) end.setTime((customEnd.includes("T") ? new Date(customEnd) : new Date(customEnd + "T23:59:59")).getTime());
      break;
    default: start.setMonth(start.getMonth() - 3);
  }
  return { start, end };
}

export function getPreviousRange(start, end) {
  const duration = end.getTime() - start.getTime();
  return { start: new Date(start.getTime() - duration), end: new Date(start) };
}

export function inRange(dateStr, start, end) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return d >= start && d <= end;
}

export function pctChange(current, previous) {
  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export function dayKeyOf(d) {
  return new Date(d).toISOString().slice(0, 10);
}