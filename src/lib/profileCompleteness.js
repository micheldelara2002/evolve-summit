/**
 * Cálculo de completude do perfil com base nos campos de Person.
 */

export const COMPLETENESS_FIELDS = [
  "contact_email",
  "phone",
  "company",
  "job_title",
  "bio",
  "linkedin",
  "instagram",
  "website",
  "youtube",
];

function isFilled(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

/** Calcula percentual de completude (0–100, inteiro) */
export function calcCompleteness(person) {
  if (!person) return 0;
  // full_name obrigatório conta separado: se preenchido +1 de bônus na base
  const base = person.full_name?.trim() ? 1 : 0;
  const optional = COMPLETENESS_FIELDS.filter((f) => isFilled(person[f])).length;
  const total = 1 + COMPLETENESS_FIELDS.length;
  return Math.round(((base + optional) / total) * 100);
}