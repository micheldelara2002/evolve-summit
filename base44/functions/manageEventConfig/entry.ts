import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyAnyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

const ALLOWED_ENTITIES = new Set([
  'Badge',
  'StoreItem',
  'ScoringRule',
  'CertificateTemplate',
]);

const PUBLIC_READ_ENTITIES = new Set(['Badge', 'StoreItem']);

const READABLE_FIELDS = {
  Badge: ['id', 'event_id', 'codigo', 'titulo', 'icone_emoji', 'icone_cor', 'categoria', 'coluna_progresso', 'criterio_tipo', 'acao_referencia', 'valor_meta', 'ativo', 'is_deleted', 'description', 'created_date', 'updated_date'],
  StoreItem: ['id', 'event_id', 'codigo_item', 'descricao_item', 'imagem_url', 'pontos_necessarios', 'estoque_total', 'quantidade_resgatada', 'limite_por_usuario', 'status', 'is_deleted', 'created_date', 'updated_date'],
  ScoringRule: ['id', 'event_id', 'acao', 'pontos', 'ativo', 'limite_tipo', 'limite_valor', 'is_deleted', 'description', 'created_date', 'updated_date'],
  CertificateTemplate: ['id', 'event_id', 'name', 'tipo', 'background_url', 'field_configs', 'is_active', 'is_deleted', 'description', 'created_date', 'updated_date'],
};

function sanitizeRecord(entityName, data = {}) {
  const allowed = new Set(READABLE_FIELDS[entityName] || []);
  const out = {};
  for (const key of Object.keys(data)) {
    if (allowed.has(key) && key !== 'id' && key !== 'event_id' && key !== 'created_date' && key !== 'updated_date') {
      out[key] = data[key];
    }
  }
  return out;
}

async function isEventParticipant(base44, user, eventId) {
  const svc = base44.asServiceRole;
  let personId = user.person_id || null;
  if (!personId && user.email) {
    const persons = await svc.entities.Person.filter({ contact_email: user.email, is_active: true });
    personId = persons?.[0]?.id || null;
  }

  const parts = await svc.entities.Participant.filter({ event_id: eventId, is_deleted: false });
  return parts.some((p) =>
    p.registration_status !== 'cancelled' &&
    ((personId && p.person_id === personId) || (user.email && p.email === user.email))
  );
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json();
    const {
      action = 'list',
      entityName,
      eventId,
      id,
      data = {},
      includeDeleted = false,
      activeOnly = false,
    } = body;

    if (!entityName || !ALLOWED_ENTITIES.has(entityName)) {
      return Response.json({ error: 'Entidade não permitida.' }, { status: 400 });
    }
    if (!eventId || typeof eventId !== 'string') {
      return Response.json({ error: 'eventId é obrigatório.' }, { status: 400 });
    }

    const svc = base44.asServiceRole;
    const isPublicRead = action === 'list' && PUBLIC_READ_ENTITIES.has(entityName);
    const isAdmin = user.role === 'admin';

    // Reads: Badge/StoreItem are visible to legitimate event participants/members.
    // ScoringRule/CertificateTemplate are management-only.
    if (action === 'list') {
      let authorized = isAdmin;
      if (!authorized) {
        if (isPublicRead) {
          const membership = await verifyAnyEventMembership(base44, user, eventId);
          authorized = membership.authorized || await isEventParticipant(base44, user, eventId);
        } else {
          const membership = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
          authorized = membership.authorized;
        }
      }
      if (!authorized) return Response.json({ error: 'Sem permissão para acessar esta configuração.' }, { status: 403 });

      const filter = { event_id: eventId };
      if (!includeDeleted) filter.is_deleted = false;
      if (activeOnly) {
        if (entityName === 'Badge') filter.ativo = true;
        if (entityName === 'StoreItem') filter.status = 'ativo';
        if (entityName === 'CertificateTemplate') filter.is_active = true;
      }
      const records = await svc.entities[entityName].filter(filter);
      return Response.json({ records });
    }

    // All mutations require event manager/team or global admin.
    const managerAuth = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
    if (!managerAuth.authorized) {
      return Response.json({ error: 'Sem permissão para alterar esta configuração.' }, { status: 403 });
    }

    if (action === 'create') {
      const clean = sanitizeRecord(entityName, data);
      clean.event_id = eventId;
      const record = await svc.entities[entityName].create(clean);
      return Response.json({ record });
    }

    if (action === 'update' || action === 'delete') {
      if (!id) return Response.json({ error: 'id é obrigatório.' }, { status: 400 });
      const existing = await svc.entities[entityName].filter({ id, event_id: eventId });
      if (!existing.length) return Response.json({ error: 'Registro não encontrado neste evento.' }, { status: 404 });

      if (action === 'delete') {
        const record = await svc.entities[entityName].update(id, { is_deleted: true });
        return Response.json({ record });
      }

      const clean = sanitizeRecord(entityName, data);
      delete clean.is_deleted;
      const record = await svc.entities[entityName].update(id, clean);
      return Response.json({ record });
    }

    return Response.json({ error: 'Ação não suportada.' }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
