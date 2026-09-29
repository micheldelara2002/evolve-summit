/**
 * Constantes e regras de papel da tela Pessoas do Evento.
 * Regra de acumulação: apenas speaker + partner_rep são acumuláveis;
 * os demais papéis são mutuamente exclusivos.
 */
export const ROLE_COLORS = {
  attendee:    "bg-slate-100 text-slate-700",
  speaker:     "bg-violet-100 text-violet-700",
  team:        "bg-emerald-100 text-emerald-700",
  manager:     "bg-amber-100 text-amber-700",
  partner_rep: "bg-sky-100 text-sky-700",
  reviewer:    "bg-cyan-100 text-cyan-700",
};

export const ROLE_LABELS = {
  attendee:    "Participante",
  speaker:     "Palestrante",
  team:        "Equipe",
  manager:     "Gerente",
  partner_rep: "Representante",
  reviewer:    "Avaliador",
};

// Only allowed accumulation: speaker + partner_rep.
// All others are mutually exclusive.
export function getDisabledRoles(selected) {
  const disabled = new Set();
  if (selected.includes("manager"))     { disabled.add("team"); disabled.add("speaker"); }
  if (selected.includes("team"))        { disabled.add("manager"); disabled.add("speaker"); }
  if (selected.includes("speaker"))     { disabled.add("manager"); disabled.add("team"); }
  // attendee is always implicit, never in disabled
  return disabled;
}