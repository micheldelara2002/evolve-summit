// getPartnerPersons — Lote 4. Lista de Persons para o diálogo de representantes
// (AdminPartners). Gate: canManagePartnerData (admin OU partner_manager da
// empresa). Mesma fonte que o Person.list anterior (até 200, ordem alfabética).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { canManagePartnerData } from '../../shared/eventAuth.ts';
import { isValidId } from '../../shared/idGuard.ts';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Não autenticado.' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const partnerId = body.partnerId;
    if (!isValidId(partnerId)) {
      return Response.json({ error: 'partnerId é obrigatório.' }, { status: 400 });
    }

    const authorized = await canManagePartnerData(base44, user, partnerId);
    if (!authorized) {
      return Response.json({ error: 'Sem permissão para gerenciar esta empresa.' }, { status: 403 });
    }

    const persons = await base44.asServiceRole.entities.Person.list('-full_name', 200);
    return Response.json({ persons });
  } catch (error) {
    console.error('getPartnerPersons error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}