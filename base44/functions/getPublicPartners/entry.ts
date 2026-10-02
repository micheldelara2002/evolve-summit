import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { partnerPublicView as publicView } from "../../shared/partnerPublicView.ts";

// Retorna apenas campos públicos de Partner (sem PII: sem contact_email,
// contact_phone, legal_document_number). Usado para exibição de patrocinadores
// e ficha pública do parceiro (qualquer usuário autenticado).

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });

    const { partnerIds, partnerId } = await req.json();
    const ids = Array.isArray(partnerIds) && partnerIds.length
      ? partnerIds
      : (partnerId ? [partnerId] : null);
    if (!ids) return Response.json({ error: 'Informe partnerIds ou partnerId.' }, { status: 400 });

    // AUD-008 (2026-10-02) — query já filtrada no banco ($in): não carrega
    // mais a coleção INTEIRA de parceiros ativos para filtrar em memória
    // (custo crescia linearmente com o cadastro a cada chamada).
    const matched = await base44.asServiceRole.entities.Partner.filter(
      { id: { $in: ids }, is_active: true, is_deleted: false }
    );
    return Response.json({ partners: matched.map(publicView) });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}