// getMyPerson — Lote 4. Leitura da PRÓPRIA Person do usuário autenticado.
// Person tem RLS admin-only; todo acesso de app user passa por aqui.
// Resolução: user.person_id (link explícito) → contact_email → Participant.email (legado).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { isValidId } from '../../shared/idGuard.ts';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Não autenticado.' }, { status: 401 });

    const svc = base44.asServiceRole;
    let person = null;

    const linkedId = isValidId(user.person_id) ? user.person_id : null;
    if (linkedId) {
      const list = await svc.entities.Person.filter({ id: linkedId });
      person = list[0] || null;
    }
    if (!person && user.email) {
      const list = await svc.entities.Person.filter({ contact_email: user.email, is_active: true });
      person = list[0] || null;
    }
    if (!person && user.email) {
      // Contas legados: Person existe mas sem link user.person_id nem contact_email igual
      const participants = await svc.entities.Participant.filter({ email: user.email, is_deleted: false });
      const pid = participants.find((p) => p.person_id)?.person_id;
      if (pid) {
        const list = await svc.entities.Person.filter({ id: pid });
        person = list[0] || null;
      }
    }

    return Response.json({ person: person || null });
  } catch (error) {
    console.error('getMyPerson error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}