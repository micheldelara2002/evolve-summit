// P2 (2026-09-29) — Fonte única da superfície PÚBLICA de Partner (sem PII:
// sem contact_email, contact_phone, legal_document_number). Era copiado com
// DRIFT em getPublicPartners (incluía is_active) e getSpeakerPartner (sem
// is_active) — despadronização de duas views "públicas" divergentes.
// Consolidado no shape SUPERSET (is_active é aditivo e inofensivo ao
// consumidor que não o lê).

const PARTNER_PUBLIC_FIELDS = [
  "id",
  "trade_name",
  "legal_name",
  "logo_url",
  "website",
  "about",
  "is_active",
];

export function partnerPublicView(p: any): any {
  const out: any = {};
  for (const f of PARTNER_PUBLIC_FIELDS) {
    if (p && p[f] !== undefined) out[f] = p[f];
  }
  return out;
}