// P2 (2026-09-29) — Fonte única de sanitização de input nas funções backend.
//
// sanitizeText era copiado idêntico em 5 funções (savePartner, saveJobPosting,
// manageConnection, getOrCreateThread, sendChatMessage); sanitizeData
// (allowlist por campo) era copiado com drift em 2 (saveMyPerson, managePerson)
// — o da segunda tratava o booleano is_active. Unificados aqui.

// Sanitiza texto livre: remove tags HTML, protocolo javascript: e event
// handlers inline (on*=). Defense-in-depth server-side.
export function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim();
}

// Sanitiza um objeto por ALLOWLIST de campos: apenas os campos listados saem;
// strings são trimadas e truncadas em maxLen; campos em booleanFields são
// convertidos para boolean estrito (data[key] === true).
export function sanitizeAllowlisted(data, allowedFields, maxLen = 2000, booleanFields = []) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const key of allowedFields) {
    if (key in data && data[key] !== undefined && data[key] !== null) {
      if (booleanFields.includes(key)) {
        out[key] = data[key] === true;
      } else {
        out[key] = String(data[key]).trim().slice(0, maxLen);
      }
    }
  }
  return out;
}