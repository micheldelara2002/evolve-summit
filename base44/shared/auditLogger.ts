// F3-08 (rodada de correção 2026-11-12) — POLÍTICA do logger GENÉRICO de auditoria.
//
// CONTEXTO: no hardening inicial o `logAuditEvent` passou a exigir gestão do
// evento (admin/manager/team), o que fechou a escrita por participante. Mas o
// cliente continuava declarando `action`, `entity_type`, `entity_id` e `details`
// livremente: um manager conseguia gravar um `role_change`, `delete` ou
// `approve` que nunca executou, e a trilha exibia o fato consumado.
//
// REGRA (duas camadas — nenhuma delas é "bloquear manager/team"):
//
//   1. OPERAÇÃO CRÍTICA não é registrada pelo cliente. Quem audita é o BACKEND
//      que executou a operação, a partir do seu próprio contexto confiável:
//        • role_change de participante/equipe → manageParticipant
//        • emissão de certificado             → issueCertificate (F3-09)
//        • trimestres financeiros (pagamento, estorno, repasse, comércio)
//                                             → commerceAudit / writeMandatoryAudit
//      Tentativa de registrar uma dessas pelo cliente → 403 explícito.
//
//   2. O que sobra no logger genérico é EVENTO AUXILIAR: sempre gravado como
//      `mandatory: false` (nunca se confunde com trilha de operação crítica) e
//      com o `entity_id` CONFERIDO no evento informado — não é possível
//      referenciar registro de outro evento nem inventar um id inexistente.
//
// Identidade e escopo NUNCA vêm do corpo: `user_id`/`user_name` são derivados do
// usuário autenticado e `event_id` já passou pelo gate de gestão na função.
// A leitura continua admin-only pela RLS da entidade AuditLog.

// Ações auxiliares (o que o cliente pode relatar sem inventar operação crítica).
export const GENERIC_AUDIT_ACTIONS = [
  'create',
  'update',
  'soft_delete',
  'status_change',
  'import',
  'export',
  'send',
] as const;

// Ações que provam operação administrativa/financeira: só o backend que a
// executou pode registrá-las.
export const CRITICAL_AUDIT_ACTIONS = [
  'role_change',
  'delete',
  'approve',
  'reject',
  'waitlist',
  'cancel',
  'archive',
  'restore',
  'publish',
  'unpublish',
  'account_deletion',
  'refund',
  'reissue',
  'checkin',
  'check_in',
] as const;

// Entidades de evento cuja alteração por gestão pode ser relatada como evento
// auxiliar (o fato é real, a operação já ocorreu via SDK ou função própria).
export const GENERIC_AUDIT_ENTITY_TYPES = [
  'Event',
  'Participant',
  'Session',
  'Track',
  'Room',
  'Badge',
  'ScoringRule',
  'StoreItem',
  'Partner',
  'EventPartner',
  'PartnerRepresentative',
  'NotificationCampaign',
  'Submission',
  'CallForPapers',
  'AwardSubmission',
  'AwardEvaluation',
  'CertificateTemplate',
  'MentorshipRequest',
  'JobPosting',
  'Lead',
  'Import',
  'Person',
] as const;

// Entidades cujo histórico é prova financeira, de acesso ou de identidade:
// auditoria exclusivamente pelo backend (RLS admin-only + trilha obrigatória).
export const CRITICAL_AUDIT_ENTITY_TYPES = [
  'Payment',
  'RefundRequest',
  'Order',
  'OrderItem',
  'EventFinance',
  'PayoutAccount',
  'Ticket',
  'AuditLog',
  'User',
  'EventMembership',
  'Certificate',
] as const;

// Como o `entity_id` é conferido contra o evento informado:
//   'self'  → o próprio registro É o evento (id === event_id)
//   'event' → o registro precisa ter event_id === event_id
//   'admin' → registro global (catálogo): só administrador
const ENTITY_ID_SCOPE: Record<string, 'self' | 'event' | 'admin'> = {
  Event: 'self',
  Participant: 'event',
  Session: 'event',
  Track: 'event',
  Room: 'event',
  Badge: 'event',
  ScoringRule: 'event',
  StoreItem: 'event',
  EventPartner: 'event',
  NotificationCampaign: 'event',
  Submission: 'event',
  CallForPapers: 'event',
  AwardSubmission: 'event',
  AwardEvaluation: 'event',
  MentorshipRequest: 'event',
  JobPosting: 'event',
  Lead: 'event',
  Import: 'event',
  Partner: 'admin',
  Person: 'admin',
  PartnerRepresentative: 'admin',
  CertificateTemplate: 'admin',
};

export type AuditDecision = { ok: true } | { ok: false; status: number; error: string };

// Validação puramente declarativa: ação e tipo de entidade.
export function classifyAuditRequest({ action, entityType }: { action: string; entityType: string }): AuditDecision {
  if (!action || action.length > 64) {
    return { ok: false, status: 400, error: 'Ação de auditoria ausente ou inválida.' };
  }
  if ((CRITICAL_AUDIT_ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false,
      status: 403,
      error: 'Operação crítica: a auditoria é gravada pelo backend que a executa.',
    };
  }
  if (!(GENERIC_AUDIT_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, status: 400, error: 'Ação de auditoria inválida.' };
  }
  if (!entityType) {
    return { ok: false, status: 400, error: 'Tipo de entidade de auditoria inválido.' };
  }
  if ((CRITICAL_AUDIT_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    return {
      ok: false,
      status: 403,
      error: 'Entidade crítica: a auditoria é gravada pelo backend que executa a operação.',
    };
  }
  if (!(GENERIC_AUDIT_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    return { ok: false, status: 400, error: 'Tipo de entidade de auditoria inválido.' };
  }
  return { ok: true };
}

// Confere que o registro referenciado existe E pertence ao evento informado.
export async function checkEntityScope(
  svc: any,
  { entityType, entityId, eventId, user }: { entityType: string; entityId: string; eventId: string; user: any },
): Promise<AuditDecision> {
  if (!entityId) return { ok: true };

  const scope = ENTITY_ID_SCOPE[entityType] || 'admin';

  // Registro global: não há evento para conferir — exige administrador.
  if (scope === 'admin') {
    if (user?.role !== 'admin') {
      return { ok: false, status: 403, error: 'Este registro só pode ser auditado por um administrador.' };
    }
    return { ok: true };
  }

  // Sem escopo de evento só o administrador registra (a função já garantiu isso).
  if (!eventId) {
    return user?.role === 'admin'
      ? { ok: true }
      : { ok: false, status: 403, error: 'Registro sem evento só pode ser auditado por um administrador.' };
  }

  const store = svc?.entities?.[entityType];
  if (!store || typeof store.filter !== 'function') {
    return { ok: false, status: 400, error: 'Entidade de auditoria desconhecida.' };
  }

  const rows = await store.filter({ id: entityId });
  const found = Array.isArray(rows) ? rows[0] : null;
  if (!found) {
    return { ok: false, status: 400, error: 'Registro referenciado não encontrado.' };
  }

  if (scope === 'self') {
    return String(found.id) === String(eventId)
      ? { ok: true }
      : { ok: false, status: 403, error: 'O registro referenciado não pertence a este evento.' };
  }

  return String(found.event_id || '') === String(eventId)
    ? { ok: true }
    : { ok: false, status: 403, error: 'O registro referenciado pertence a outro evento.' };
}

// Caminho único de escrita do logger genérico. Devolve a decisão e, quando
// aceito, o registro efetivamente persistido (o caller devolve o id).
export async function recordClientAudit(
  svc: any,
  { user, eventId, ip, body }: { user: any; eventId: string; ip?: string; body: any },
): Promise<{ ok: true; record: any } | { ok: false; status: number; error: string }> {
  const action = String(body?.action ?? '').trim();
  const entityType = String(body?.entity_type ?? '').trim();
  const entityId = String(body?.entity_id ?? '').trim();

  if (entityId.length > 128) {
    return { ok: false, status: 400, error: 'entity_id inválido.' };
  }

  const kind = classifyAuditRequest({ action, entityType });
  if (!kind.ok) return kind;

  if (!eventId && user?.role !== 'admin') {
    return { ok: false, status: 403, error: 'Sem permissão para registrar auditoria sem escopo de evento.' };
  }

  const scope = await checkEntityScope(svc, { entityType, entityId, eventId, user });
  if (!scope.ok) return scope;

  const raw = typeof body?.details === 'string' ? body.details : JSON.stringify(body?.details ?? {});
  const details = raw.length > 10000 ? raw.slice(0, 10000) : raw;

  const record = await svc.entities.AuditLog.create({
    event_id: eventId || '',
    action,
    entity_type: entityType,
    entity_id: entityId,
    // Identidade e escopo derivados do contexto autenticado — nunca do corpo.
    user_id: user.id,
    user_name: user.full_name || user.email || '',
    details,
    ip_address: ip || '',
    // Evento AUXILIAR: jamais confundível com trilha de operação crítica.
    mandatory: false,
    status: 'recorded',
  });

  return { ok: true, record };
}