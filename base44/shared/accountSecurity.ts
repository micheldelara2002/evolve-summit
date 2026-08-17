// P0 — Backend account-status guard.
//
// Blocks users with account_status='deleted' from performing mutations via
// backend functions, even if they hold a valid (pre-deletion) auth token.
// The frontend AuthContext guard is not sufficient — a deleted user with a
// valid token could still invoke functions directly via HTTP.
//
// Usage (top of an entry.ts, replacing the `auth.me()` + 401 check):
//   import { requireActiveUser } from "../../shared/accountSecurity.ts";
//   ...
//   const guard = await requireActiveUser(base44);
//   if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
//   const user = guard.user;
//
// Returns the auth.me() user (unchanged shape) when active.
// Does NOT use role as a blocking mechanism and does NOT alter admin perms.

export async function requireActiveUser(base44) {
  const user = await base44.auth.me();
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' };

  // Authoritative check: read account_status fresh from the User record.
  // auth.me() may be cached in the session; the DB is the source of truth.
  const records = await base44.asServiceRole.entities.User.filter({ id: user.id });
  const dbUser = records?.[0];
  if (!dbUser) return { ok: false, status: 401, error: 'Unauthorized' };

  if (dbUser.account_status === 'deleted') {
    return { ok: false, status: 403, error: 'Conta excluída — operação não permitida.' };
  }
  return { ok: true, user };
}