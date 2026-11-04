import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { incPersons } from "../../shared/businessMetrics.ts";
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { normalizeEmail } from "../../shared/identity.ts";

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
// CADASTRO ÚNICO (2026-11-04): uma conta por e-mail é garantida pela autenticação da
// plataforma (o segundo signup com o mesmo e-mail não cria conta). Aqui o e-mail
// normalizado é a chave do cadastro global de pessoa: se já existe Person ativa com
// ele, NENHUMA segunda é criada — a existente é vinculada ao usuário. Mais de uma
// correspondência é ambiguidade: o vínculo é interrompido e a revisão é exigida.
// O vínculo explícito (User.person_id) é PERSISTIDO, para que a identidade não
// dependa do e-mail nas próximas requisições.
export default async function(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { user_id } = body;

    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;

    let resolvedEmail = null;
    let resolvedName = null;
    let authenticatedUser = null;
    // Conta (User) que está sendo ligada a uma Person nesta chamada.
    let accountUser = null;

    // 1. Authenticated path — identity from auth.me(), never from client body.
    //    P1: requireActiveUser blocks account_status='deleted' from mutating.
    try {
      const guard = await requireActiveUser(base44);
      if (guard.ok) {
        authenticatedUser = guard.user;
        accountUser = guard.user;
        resolvedEmail = guard.user.email;
        resolvedName = guard.user.full_name || "Novo Usuário";
      } else if (guard.status === 403) {
        // Deleted account — block authenticated mutation.
        return Response.json({ error: guard.error }, { status: guard.status });
      }
      // 401 → no auth context — fall through to workflow/system path.
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
      const users = await svc.entities.User.filter({ id: user_id });
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
      accountUser = systemUser;
      resolvedEmail = systemUser.email;
      resolvedName = systemUser.full_name || "Novo Usuário";
    }

    // Persiste o vínculo explícito User → Person. É o que torna a identidade
    // estável entre sessões (o e-mail deixa de ser a única âncora).
    async function linkAccountToPerson(personId: string) {
      if (!accountUser?.id || !personId) return;
      if (accountUser.person_id === personId) return;
      try {
        await svc.entities.User.update(accountUser.id, { person_id: personId });
      } catch (linkErr: any) {
        console.error('[getOrCreatePerson] vínculo person_id não persistido:', linkErr?.message || linkErr);
      }
    }

    // 2b. P1-A — vínculo explícito tem PRECEDÊNCIA sobre o e-mail: o sistema
    //     já declarou quem é esta pessoa.
    if (accountUser?.person_id) {
      const linked = await svc.entities.Person.filter({ id: accountUser.person_id });
      if (linked?.[0]?.id) return Response.json({ status: "exists", person_id: linked[0].id });
    }

    // 3. Idempotent lookup — return existing Person if one is already linked.
    //    P1-A — e-mail normalizado; MAIS DE UMA correspondência é ambiguidade,
    //    não escolha: nada é criado e o chamador é informado.
    resolvedEmail = normalizeEmail(resolvedEmail);
    const existing = await svc.entities.Person.filter({
      contact_email: resolvedEmail,
      is_active: { $ne: false },
    });
    if (existing.length > 1) {
      return Response.json({
        status: "ambiguous",
        reason: "identity_ambiguous",
        person_ids: existing.map((p) => p.id),
        error: "Mais de um cadastro de pessoa com este e-mail — consolide o cadastro antes de continuar.",
      }, { status: 409 });
    }
    if (existing.length === 1) {
      await linkAccountToPerson(existing[0].id);
      return Response.json({ status: "exists", person_id: existing[0].id });
    }

    // 4. Create Person for the resolved (trusted) identity.
    const person = await svc.entities.Person.create({
      full_name: resolvedName,
      contact_email: resolvedEmail,
      is_active: true,
      created_day: new Date().toISOString().slice(0, 10),
      metrics_inc: true, // P1 — direct incPersons below is the single count for this Person
    });
    // P0.3 — bucket global diário de persons (best-effort; reconcile corrige drift)
    try { await incPersons(base44.asServiceRole, person.created_date); } catch {}

    await linkAccountToPerson(person.id);
    return Response.json({ status: "created", person_id: person.id });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}