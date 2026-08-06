import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * Migração ponte: espelha os papéis administrativos atuais do Participant (role_in_event)
 * para a nova entidade EventMembership. Idempotente — não duplica vínculos já existentes.
 * Cria EventMembership com user_id quando encontra o User vinculado (por person_id ou email),
 * permitindo que o RLS de EventMembership funcione para o usuário ler suas próprias memberships.
 *
 * Admin-only.
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
    const participants = await svc.entities.Participant.filter({ is_deleted: false }, undefined, 1000);
    const users = await svc.entities.User.list('-created_date', 1000);

    const usersByEmail = new Map();
    const usersByPersonId = new Map();
    for (const u of users) {
      if (u.email) usersByEmail.set(String(u.email).toLowerCase(), u);
      if (u.person_id) usersByPersonId.set(u.person_id, u);
    }

    const existing = await svc.entities.EventMembership.filter({ is_deleted: false }, undefined, 1000);
    const existingKeys = new Set(existing.map((m) => `${m.event_id}|${m.person_id}|${m.role}`));

    let created = 0, skipped = 0, noPerson = 0, noUser = 0;

    for (const p of participants) {
      const role = p.role_in_event;
      if (!role || role === 'attendee') continue;
      if (!p.person_id) { noPerson++; continue; }

      const key = `${p.event_id}|${p.person_id}|${role}`;
      if (existingKeys.has(key)) { skipped++; continue; }

      const linkedUser = usersByPersonId.get(p.person_id)
        || (p.email ? usersByEmail.get(String(p.email).toLowerCase()) : null);

      await svc.entities.EventMembership.create({
        event_id: p.event_id,
        person_id: p.person_id,
        person_name: p.full_name,
        user_id: linkedUser?.id || '',
        user_email: linkedUser?.email || p.email || '',
        role,
        is_active: true,
      });
      existingKeys.add(key);
      created++;
      if (!linkedUser) noUser++;
    }

    return Response.json({
      ok: true,
      created,
      skipped,
      no_person: noPerson,
      no_user: noUser,
      total: created + skipped,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}