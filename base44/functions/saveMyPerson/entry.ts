// saveMyPerson — Lote 4. Create-or-update da PRÓPRIA Person do usuário (perfil).
// Sanitiza campos, valida email, e cria com contact_email = user.email quando
// não existe. Contador global de persons (bucket diário) é idempotente via
// Person.metrics_inc. RLS Person é admin-only — escrita só por aqui (service role).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { isValidId } from '../../shared/idGuard.ts';
import { incPersons } from '../../shared/businessMetrics.ts';

const ALLOWED_FIELDS = [
  'full_name', 'contact_email', 'phone', 'company', 'job_title',
  'photo_url', 'bio', 'linkedin', 'instagram', 'youtube', 'website',
];
const MAX_LEN = 2000;

function sanitizeData(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const key of ALLOWED_FIELDS) {
    if (key in data && data[key] !== undefined && data[key] !== null) {
      out[key] = String(data[key]).trim().slice(0, MAX_LEN);
    }
  }
  return out;
}

function isValidEmail(value) {
  return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function resolveOwnPerson(svc, user) {
  let person = null;
  const linkedId = isValidId(user.person_id) ? user.person_id : null;
  if (linkedId) {
    const list = await svc.entities.Person.filter({ id: linkedId });
    person = list[0] || null;
  }
  if (!person && user.email) {
    const list = await svc.entities.Person.filter({ contact_email: user.email, is_active: true });
    person = list[0] || null;
  }
  return person;
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Não autenticado.' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const data = sanitizeData(body.data);
    if (!isValidEmail(data.contact_email)) {
      return Response.json({ error: 'E-mail de contato inválido.' }, { status: 400 });
    }
    // Foto é opcional; nome obrigatório na criação
    const existing = await resolveOwnPerson(base44.asServiceRole, user);

    if (existing) {
      if (!data.full_name && !existing.full_name) {
        return Response.json({ error: 'Nome é obrigatório.' }, { status: 400 });
      }
      const updated = await base44.asServiceRole.entities.Person.update(existing.id, data);
      return Response.json({ person: updated });
    }

    if (!data.full_name) {
      return Response.json({ error: 'Nome é obrigatório.' }, { status: 400 });
    }
    if (!data.contact_email) data.contact_email = user.email;
    const created = await base44.asServiceRole.entities.Person.create({
      ...data,
      created_day: new Date().toISOString().slice(0, 10),
    });
    // P1 — contador global idempotente (reconcile corrige drift)
    try {
      if (created && created.metrics_inc !== true) {
        await incPersons(base44.asServiceRole, created.created_date || new Date().toISOString());
        await base44.asServiceRole.entities.Person.update(created.id, { metrics_inc: true });
      }
    } catch (e) { /* best-effort */ }
    return Response.json({ person: created });
  } catch (error) {
    console.error('saveMyPerson error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}