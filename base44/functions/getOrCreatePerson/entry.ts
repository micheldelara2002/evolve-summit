import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

export default async function(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { email, full_name } = body;

    if (!email) {
      return Response.json({ error: "email is required" }, { status: 400 });
    }

    const base44 = createClientFromRequest(req);

    // 1. Verifica se já existe uma Person com esse email
    const existing = await base44.asServiceRole.entities.Person.filter({ contact_email: email });
    if (existing.length > 0) {
      return Response.json({ status: "exists", person_id: existing[0].id });
    }

    // 2. Cria uma Person básica vinculada pelo email
    const person = await base44.asServiceRole.entities.Person.create({
      full_name: full_name || "Novo Usuário",
      contact_email: email,
      is_active: true
    });

    return Response.json({ status: "created", person_id: person.id });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}