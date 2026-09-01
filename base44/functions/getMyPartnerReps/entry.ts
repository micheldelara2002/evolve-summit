import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveUserPersonId } from "../../shared/eventAuth.ts";

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    if (!user?.id) return Response.json({ error: 'Usuário inválido.' }, { status: 400 });

    const userPersonId = await resolveUserPersonId(base44, user);

    const queries = [
      base44.asServiceRole.entities.PartnerRepresentative.filter({
        user_id: user.id,
        is_active: true,
        is_deleted: false,
      }),
    ];
    if (userPersonId) {
      queries.push(
        base44.asServiceRole.entities.PartnerRepresentative.filter({
          person_id: userPersonId,
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
});