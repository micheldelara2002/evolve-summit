// getPartnerPersons — Lote 4 / INF-002. Persons para o diálogo de
// representantes (AdminPartners). Gate: requireActiveUser (conta excluída
// bloqueada) + canManagePartnerData (admin OU partner_manager da empresa).
//
// INF-002 — NUNCA devolve o catálogo global de Persons:
//   1. Sempre retorna SOMENTE as Persons vinculadas ao parceiro
//      (PartnerRepresentative, ativos e inativos).
//   2. Busca externa OPCIONAL e mínima: exige termo explícito de >= 3
//      caracteres (nome ou e-mail), teto de 20 resultados por consulta e
//      campos mínimos (id, nome, e-mail, ativo) — sem PII sensível.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from '../../shared/accountSecurity.ts';
import { canManagePartnerData } from '../../shared/eventAuth.ts';
import { isValidId } from '../../shared/idGuard.ts';

const SEARCH_MIN = 3;
const SEARCH_MAX_RESULTS = 20;
const SEARCH_POOL = 500;

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

    // 1. Persons vinculadas ao parceiro (reps ativos e inativos) — base fixa.
    const reps = await svc.entities.PartnerRepresentative.filter({ partner_id: partnerId, is_deleted: false });
    const linkedIds = [...new Set(reps.map((r) => r.person_id).filter(Boolean))];
    const personsById = new Map();
    if (linkedIds.length > 0) {
      const linked = await svc.entities.Person.filter({ id: { $in: linkedIds } });
      for (const p of linked) personsById.set(p.id, p);
    }

    // 2. Busca externa mínima (opcional): termo explícito, paginada por teto.
    const search = String(body.search || '').trim().toLowerCase();
    if (search.length >= SEARCH_MIN) {
      const pool = await svc.entities.Person.list('-full_name', SEARCH_POOL);
      let matched = 0;
      for (const p of pool) {
        if (matched >= SEARCH_MAX_RESULTS) break;
        if (personsById.has(p.id)) continue;
        const name = String(p.full_name || '').toLowerCase();
        const email = String(p.contact_email || '').toLowerCase();
        if (name.includes(search) || email.includes(search)) {
          personsById.set(p.id, p);
          matched++;
        }
      }
    }

    return Response.json({ persons: [...personsById.values()].map(minimalPerson) });
  } catch (error) {
    console.error('getPartnerPersons error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}