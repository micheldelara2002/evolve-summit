import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveUserPersonIds } from "../../shared/eventAuth.ts";

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    if (!user?.id) return Response.json({ error: 'Usuário inválido.' }, { status: 400 });

    // P1-A — conjunto verificado: um usuário pode responder por mais de uma
    // Person; todas as correspondências contam (nenhum vínculo fica oculto).
    const userPersonIds = await resolveUserPersonIds(base44, user);

    const queries = [
      base44.asServiceRole.entities.PartnerRepresentative.filter({
        user_id: user.id,
        is_active: true,
        is_deleted: false,
      }),
    ];
    if (userPersonIds.length > 0) {
      queries.push(
        base44.asServiceRole.entities.PartnerRepresentative.filter({
          person_id: { $in: userPersonIds },
          is_active: true,
          is_deleted: false,
        })
      );
    }
    const [byUser, byPerson] = await Promise.all(queries);
    const seen = new Set();
    const reps = [...(byUser || []), ...(byPerson || [])].filter(
      (r) => !seen.has(r.id) && seen.add(r.id)
    );
    return Response.json({ partnerReps: reps });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}