// getMyPerson — Lote 4. Leitura da PRÓPRIA Person do usuário autenticado.
// Person tem RLS admin-only; todo acesso de app user passa por aqui.
//
// P1-A (2026-11-04) — resolução pela identidade canônica (shared/identity.ts):
//   1. vínculo explícito user.person_id;
//   2. e-mail normalizado (todas as correspondências);
//   3. legado: Participant do usuário que já aponta para uma Person.
// Vínculo explícito vence. Sem vínculo e com MAIS DE UMA Person correspondente,
// a leitura é NEGADA com motivo (nunca "pega a primeira").
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from '../../shared/accountSecurity.ts';
import { resolveIdentity } from '../../shared/identity.ts';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    // SEC-004 — guard de conta ativa: conta excluída com token válido é bloqueada.
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const svc = base44.asServiceRole;
    const identity = await resolveIdentity(base44, user);

    if (identity.ambiguous) {
      return Response.json({
        error: 'Há mais de um cadastro de pessoa com o seu e-mail. A organização precisa consolidar seu cadastro antes de continuar.',
        reason: 'identity_ambiguous',
        person_ids: identity.personIds,
      }, { status: 409 });
    }

    let person = null;
    if (identity.selfPersonId) {
      const list = await svc.entities.Person.filter({ id: identity.selfPersonId });
      person = list[0] || null;
    }

    // Contas legadas: Person existe mas sem vínculo e sem e-mail correspondente —
    // o Participant do usuário já aponta para ela.
    if (!person && identity.emailNorm) {
      const participants = await svc.entities.Participant.filter({
        email: { $in: identity.emailVariants },
        is_deleted: false,
      });
      const linkedIds = [...new Set((participants || []).map((p) => p.person_id).filter(Boolean))];
      if (linkedIds.length === 1) {
        const list = await svc.entities.Person.filter({ id: linkedIds[0] });
        person = list[0] || null;
      } else if (linkedIds.length > 1) {
        return Response.json({
          error: 'Há mais de um cadastro de pessoa vinculado ao seu e-mail. A organização precisa consolidar seu cadastro antes de continuar.',
          reason: 'identity_ambiguous',
          person_ids: linkedIds,
        }, { status: 409 });
      }
    }

    return Response.json({ person: person || null });
  } catch (error) {
    console.error('getMyPerson error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}