import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * Migração ponte (one-time): renomeia User.role de "member" → "user" para
 * alinhar ao padrão nativo Base44 (admin | user). Idempotente — só atualiza
 * usuários com role === "member". O label exibido ("Membro") é definido no
 * frontend via ROLE_LABELS, não muda.
 *
 * Admin-only. Usa asServiceRole pois bulk update de User via SDK cliente
 * retorna 405.
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') {
      return Response.json({ error: 'Forbidden — apenas admin' }, { status: 403 });
    }

    const svc = base44.asServiceRole;

    // Lista todos os users (assume escala < 1000; se crescer, paginar)
    const users = await svc.entities.User.list('-created_date', 1000);
    const toMigrate = users.filter((u) => u.role === 'member');

    let updated = 0;
    let failed = 0;
    const errors = [];

    for (const u of toMigrate) {
      try {
        await svc.entities.User.update(u.id, { role: 'user' });
        updated++;
      } catch (e) {
        failed++;
        errors.push({ id: u.id, email: u.email, error: e.message });
      }
    }

    return Response.json({
      ok: true,
      scanned: users.length,
      migrated: updated,
      failed,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}