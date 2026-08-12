import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// P0.4 + P0 residual — Hardened identity resolution.
//
// Identity is resolved in order of trust:
//   1. Authenticated user (auth.me()) — frontend calls. Body is IGNORED entirely.
//   2. Workflow/system path — app_user_auth:signup trigger provides user_id (not email).
//      We fetch the User by ID and use that user's email + full_name.
//
// The email-based path has been ELIMINATED. Callers cannot probe whether an arbitrary
// email belongs to a registered user — the only unauthenticated path requires a valid
// user_id, which the caller cannot guess or enumerate.
//
// This preserves the "Criar Person no Cadastro" workflow (trigger provides user_id)
// while blocking: email enumeration, creation for non-users, impersonation.
export default async function(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { user_id } = body;

    const base44 = createClientFromRequest(req);

    let resolvedEmail = null;
    let resolvedName = null;

    // 1. Authenticated path — identity from auth.me(), never from client body.
    try {
      const authUser = await base44.auth.me();
      if (authUser && authUser.email) {
        resolvedEmail = authUser.email;
        resolvedName = authUser.full_name || "Novo Usuário";
      }
    } catch {
      // No user auth context — fall through to workflow/system path.
    }

    // 2. Workflow/system path — resolve identity by user_id (NOT email).
    //    The app_user_auth:signup trigger provides user_id, which is a system-trusted
    //    value the caller cannot guess or enumerate. We fetch the User record to get
    //    the email + full_name, then proceed. No email probing is possible.
    if (!resolvedEmail) {
      if (!user_id) {
        return Response.json({ error: "identity could not be established — user_id required" }, { status: 401 });
      }
      const users = await base44.asServiceRole.entities.User.filter({ id: user_id });
      if (users.length === 0) {
        return Response.json({ error: "identity does not match a registered user" }, { status: 403 });
      }
      const systemUser = users[0];
      // P0 residual: restrict user_id path to the signup workflow context.
      // The app_user_auth:signup trigger fires immediately on signup, so the user_id
      // is always fresh. External unauthenticated callers cannot exploit stale user_ids.
      const createdAt = new Date(systemUser.created_date);
      const ageMinutes = (Date.now() - createdAt.getTime()) / 60000;
      if (ageMinutes > 5) {
        return Response.json({ error: "identity window expired" }, { status: 403 });
      }
      resolvedEmail = systemUser.email;
      resolvedName = systemUser.full_name || "Novo Usuário";
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