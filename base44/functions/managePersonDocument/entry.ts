import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { requireActiveUser } from "../../shared/accountSecurity.ts";

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const { operation, documentId, data = {} } = body;
    if (!operation) return Response.json({ error: "operation é obrigatório." }, { status: 400 });

    const isAdmin = user.role === "admin";
    const callerPersonId = user.person_id || null;
    if (!isAdmin && !callerPersonId) return Response.json({ error: "Usuário sem Person vinculada." }, { status: 403 });

    if (operation === "create") {
      const payload = { ...data };
      if (!isAdmin) payload.person_id = callerPersonId;
      if (!payload.person_id) return Response.json({ error: "person_id é obrigatório." }, { status: 400 });
      const created = await svc.entities.PersonDocument.create(payload);
      return Response.json({ document: created });
    }

    if (!documentId) return Response.json({ error: "documentId é obrigatório." }, { status: 400 });
    const docs = await svc.entities.PersonDocument.filter({ id: documentId });
    const doc = docs?.[0];
    if (!doc) return Response.json({ error: "Documento não encontrado." }, { status: 404 });
    if (!isAdmin && doc.person_id !== callerPersonId) return Response.json({ error: "Sem permissão para este documento." }, { status: 403 });

    if (operation === "update") {
      const payload = { ...data };
      // Ownership is immutable for non-admin callers.
      if (!isAdmin) delete payload.person_id;
      const updated = await svc.entities.PersonDocument.update(documentId, payload);
      return Response.json({ document: updated });
    }

    if (operation === "delete") {
      await svc.entities.PersonDocument.delete(documentId);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Operação inválida." }, { status: 400 });
  } catch (error: any) {
    return Response.json({ error: error?.message || "Erro ao gerenciar documento." }, { status: 500 });
  }
}
