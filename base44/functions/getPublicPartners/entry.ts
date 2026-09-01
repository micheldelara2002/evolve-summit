import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";

// Retorna apenas campos públicos de Partner (sem PII: sem contact_email,
// contact_phone, legal_document_number). Usado para exibição de patrocinadores
// e ficha pública do parceiro (qualquer usuário autenticado).
function publicView(p) {
  return {
    id: p.id,
    trade_name: p.trade_name,
    legal_name: p.legal_name,
    logo_url: p.logo_url,
    website: p.website,
    about: p.about,
    is_active: p.is_active,
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });

    const { partnerIds, partnerId } = await req.json();
    const ids = Array.isArray(partnerIds) && partnerIds.length
      ? partnerIds
      : (partnerId ? [partnerId] : null);
    if (!ids) return Response.json({ error: 'Informe partnerIds ou partnerId.' }, { status: 400 });

    const all = await base44.asServiceRole.entities.Partner.filter({ is_active: true, is_deleted: false });
    const wanted = new Set(ids);
    const partners = all.filter((p) => wanted.has(p.id)).map(publicView);
    return Response.json({ partners });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});