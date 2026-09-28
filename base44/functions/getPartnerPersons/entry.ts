// getPartnerPersons — INF-002. Persons para o diálogo de representantes
// (AdminPartners). Gate: requireActiveUser (conta excluída → 403) +
// canManagePartnerData (admin OU partner_manager da empresa; parceiro alheio
// → 403).
//
// INF-002 (endurecido 2026-09-28) — ELIMINADA a enumeração global de Persons:
//   1. Retorna SOMENTE as Persons vinculadas ao parceiro consultado
//      (PartnerRepresentative — vínculos ativos e inativos).
//   2. O parâmetro `search` é um FILTRO sobre as vinculadas (nome/e-mail) —
//      jamais uma busca no catálogo global. Termo < 3 caracteres → lista vazia
//      (não relaxa o escopo).
//   3. Associar uma pessoa NOVA à empresa é fluxo administrativo separado e
//      explicitamente autorizado (savePartnerRep com person_id explícito) — o
//      partner manager NÃO pesquisa a base inteira.
//   4. Campos mínimos (id, nome, e-mail, ativo) — sem PII sensível.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { requireActiveUser } from '../../shared/accountSecurity.ts';
import { canManagePartnerData } from '../../shared/eventAuth.ts';
import { isValidId } from '../../shared/idGuard.ts';

const SEARCH_MIN = 3;

function minimalPerson(p) {
  return {
    id: p.id,
    full_name: p.full_name || '',
    contact_email: p.contact_email || '',
    is_active: p.is_active !== false,
  };
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;

    const body = await req.json().catch(() => ({}));
    const partnerId = body.partnerId;
    if (!isValidId(partnerId)) {
      return Response.json({ error: 'partnerId é obrigatório.' }, { status: 400 });
    }

    const authorized = await canManagePartnerData(base44, user, partnerId);
    if (!authorized) {
      return Response.json({ error: 'Sem permissão para gerenciar esta empresa.' }, { status: 403 });
    }

    // Persons vinculadas ao parceiro (reps ativos e inativos) — base ÚNICA.
    // Nenhuma listagem/busca global: quem não tem PartnerRepresentative aqui
    // simplesmente não existe para este endpoint.
    const reps = await svc.entities.PartnerRepresentative.filter({ partner_id: partnerId, is_deleted: false });
    const linkedIds = [...new Set(reps.map((r) => r.person_id).filter(Boolean))];
    let persons = [];
    if (linkedIds.length > 0) {
      persons = await svc.entities.Person.filter({ id: { $in: linkedIds } });
    }

    // Filtro local sobre as vinculadas (nunca busca externa).
    const search = String(body.search || '').trim().toLowerCase();
    if (search) {
      if (search.length < SEARCH_MIN) {
        persons = [];
      } else {
        persons = persons.filter((p) =>
          String(p.full_name || '').toLowerCase().includes(search) ||
          String(p.contact_email || '').toLowerCase().includes(search)
        );
      }
    }

    return Response.json({ persons: persons.map(minimalPerson) });
  } catch (error) {
    console.error('getPartnerPersons error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}