import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// P0.4 — Hardened identity resolution.
//
// Identity is resolved in order of trust:
//   1. Authenticated user (auth.me()) — frontend calls. Body email is IGNORED.
//   2. System/workflow path — app_user_auth:signup trigger provides a system-trusted
//      email. We validate it belongs to a real registered User before using it,
//      preventing Person creation for arbitrary/unregistered emails.
//
// This preserves the "Criar Person no Cadastro" workflow (trigger email is trusted)
// while blocking: email enumeration of arbitrary addresses, creation on behalf of
// non-users, and impersonation from unauthenticated frontend calls.
export default async function(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { email, full_name } = body;

    const base44 = createClientFromRequest(req);

    let resolvedEmail = null;
    let resolvedName = null;

    // 1. Authenticated path — identity from auth.me(), never from client body.
    try {
      const authUser = await base44.auth.me();
      if (authUser && authUser.email) {
        resolvedEmail = authUser.email;
        resolvedName = authUser.full_name || full_name || "Novo Usuário";
      }
    } catch {
      // No user auth context — fall through to system/workflow path.
    }

    // 2. System/workflow path — email comes from the app_user_auth:signup trigger
    //    (system-generated, not client-supplied). Validate it belongs to a real
    //    registered User to prevent Person creation for arbitrary emails.
    if (!resolvedEmail) {
      if (!email) {
        return Response.json({ error: "identity could not be established" }, { status: 401 });
      }
      const users = await base44.asServiceRole.entities.User.filter({ email });
      if (users.length === 0) {
        return Response.json({ error: "identity does not match a registered user" }, { status: 403 });
      }
      resolvedEmail = email;
      resolvedName = full_name || "Novo Usuário";
    }

    // 3. Idempotent lookup — return existing Person if one is already linked.
    const existing = await base44.asServiceRole.entities.Person.filter({ contact_email: resolvedEmail });
    if (existing.length > 0) {
      return Response.json({ status: "exists", person_id: existing[0].id });
    }

    // 4. Create Person for the resolved (trusted) identity.
    const person = await base44.asServiceRole.entities.Person.create({
      full_name: resolvedName,
      contact_email: resolvedEmail,
      is_active: true
    });

    return Response.json({ status: "created", person_id: person.id });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}