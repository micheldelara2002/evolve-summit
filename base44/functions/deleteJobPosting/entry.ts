import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveUserPersonId, verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { id } = await req.json();
    if (!id) return Response.json({ error: 'id obrigatório.' }, { status: 400 });

    const jobs = await base44.asServiceRole.entities.JobPosting.filter({ id, is_deleted: false });
    const job = jobs?.[0];
    if (!job) return Response.json({ error: 'Vaga não encontrada.' }, { status: 404 });

    const userPersonId = await resolveUserPersonId(base44, user);
    const isOwner = !!userPersonId && job.person_id === userPersonId;
    const { authorized: isMod } = await verifyEventMembership(base44, user, job.event_id, EVENT_MANAGER_ROLES);
    if (!isOwner && !isMod) return Response.json({ error: 'Sem permissão para excluir esta vaga.' }, { status: 403 });

    await base44.asServiceRole.entities.JobPosting.update(id, { is_deleted: true });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});