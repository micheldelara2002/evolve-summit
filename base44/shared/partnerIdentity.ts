// 2026-11-04 — IDENTIDADE GLOBAL DE PARCEIRO (única implementação).
//
// Problema: o Partner é global (a mesma empresa patrocina vários eventos), mas
// nem todo parceiro tem CNPJ — "Agilistas de São Paulo" (coletivo), um podcast
// de pessoa física. Nome isolado não é chave confiável (duas empresas podem ter
// o mesmo nome fantasia), então a regra é:
//
//   1. Com documento → a chave é o documento. Duplicata é recusada sempre.
//   2. Sem documento → a chave é o nome normalizado, mas a criação exige
//      CONFIRMAÇÃO explícita quando já existe nome semelhante (revisão humana).
//
// Uma vez criado, o parceiro tem id e identity_key estáveis — os eventos
// seguintes o encontram e vinculam em vez de recriar.

const LEGAL_SUFFIXES = new Set([
  "ltda", "me", "epp", "mei", "eireli", "sa", "s", "a", "ss", "cia", "s/a",
]);

export function normalizePartnerName(value: any): string {
  const base = String(value == null ? "" : value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const cleaned = base.replace(/&/g, " e ").replace(/[^a-z0-9]+/g, " ").trim();
  if (!cleaned) return "";
  const words = cleaned.split(/\s+/).filter(Boolean);
  const stripped = words.filter((w) => !LEGAL_SUFFIXES.has(w));
  const finalWords = stripped.length ? stripped : words;
  return finalWords.join("-");
}

export function normalizeDocumentNumber(value: any): string {
  return String(value == null ? "" : value).replace(/[^0-9a-z]/gi, "").toUpperCase();
}

export function partnerIdentityMode(partner: any): "formal" | "informal" {
  return partner?.identity_mode === "informal" ? "informal" : "formal";
}

/** Chave de documento — null quando não há documento utilizável. */
export function partnerDocKey(partner: any): string | null {
  const digits = normalizeDocumentNumber(partner?.legal_document_number);
  if (!digits) return null;
  const country = String(partner?.legal_country_code || "BR").trim().toUpperCase();
  const type = String(partner?.legal_document_type || "CNPJ").trim().toUpperCase();
  return `doc:${country}:${type}:${digits}`;
}

/** Chave canônica de identidade do parceiro (documento vence o nome). */
export function partnerIdentityKey(partner: any): string | null {
  const mode = partnerIdentityMode(partner);
  if (mode === "formal") {
    const docKey = partnerDocKey(partner);
    if (docKey) return docKey;
  }
  const nameKey = normalizePartnerName(partner?.trade_name || partner?.legal_name);
  if (nameKey) return `name:${nameKey}`;
  const docKey = partnerDocKey(partner);
  return docKey;
}

/**
 * Campos derivados que todo Partner grava. Chamado por savePartner em create e
 * update, para que a chave acompanhe mudanças de nome/documento.
 */
export function partnerIdentityFields(payload: any) {
  const mode = partnerIdentityMode(payload);
  const normalizedName = normalizePartnerName(payload?.trade_name || payload?.legal_name);
  const docKey = partnerDocKey(payload);
  const identityKey = mode === "formal" && docKey ? docKey : normalizedName ? `name:${normalizedName}` : docKey;
  return {
    identity_mode: mode,
    identity_key: identityKey || null,
    identity_doc_key: docKey || null,
    normalized_name: normalizedName || null,
  };
}

/** Campos públicos de um parceiro para telas de outro evento (sem PII extra). */
export function partnerSearchView(partner: any) {
  return {
    id: partner.id,
    trade_name: partner.trade_name || "",
    legal_name: partner.legal_name || "",
    identity_mode: partnerIdentityMode(partner),
    legal_country_code: partner.legal_country_code || "",
    legal_document_type: partner.legal_document_type || "",
    legal_document_number: partner.legal_document_number || "",
    normalized_name: partner.normalized_name || "",
    identity_key: partner.identity_key || "",
    contact_email: partner.contact_email || "",
    website: partner.website || "",
    logo_url: partner.logo_url || "",
    is_active: partner.is_active !== false,
    created_date: partner.created_date || null,
  };
}