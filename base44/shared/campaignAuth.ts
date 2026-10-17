// campaignAuth (2026-10-17) — Verificação de autorização de emissor de campanha.
// Fonte ÚNICA das regras de negócio, usada por:
//   - manageNotificationCampaign (criação/edição/agendamento);
//   - dispatchNotificationCampaign (disparo manual);
//   - expireStaleReservations (disparo AGENDADO — a permissão deixou de ser
//     "confiada no agendamento": revalida emissor, estado da conta e
//     autorização atual no momento do disparo).
// Regras espelham o comportamento anterior do dispatch manual (mesmo conjunto
// de consultas), com uma exceção deliberada: my_attendees agora exige
// membership 'speaker' no evento (antes: qualquer membership) — alinhado à
// régua do frontend (EVENT_ROLE_SEGMENTS.speaker = ['my_attendees']).
import { verifyEventMembership, verifyAnyEventMembership, EVENT_MANAGER_ROLES } from "./eventAuth.ts";

export const CAMPAIGN_BROADCAST_AUDIENCES = ['all', 'segment', 'manual'];
export const CAMPAIGN_PARTNER_AUDIENCES = ['my_leads', 'partner_leads', 'partner_all_event'];
export const VALID_AUDIENCE_TYPES = [
  'all', 'segment', 'manual', 'my_leads', 'my_attendees', 'partner_all_event', 'partner_leads',
];
// Segmentos válidos por escopo (bloqueia manipulação de payload — ex.: segmento
// 'admin' dentro de um evento, que escalaria a audiência para fora do evento).
export const EVENT_ALLOWED_SEGMENTS = ['all', 'gerente', 'staff', 'palestrante', 'representante', 'attendee'];
export const GLOBAL_ALLOWED_SEGMENTS = ['all', 'admin', 'gerente', 'staff', 'palestrante', 'representante', 'attendee'];

// Resolve o partner_id de uma campanha: o parâmetro explícito vence; senão,
// o JSON persistido no audience_payload ({partner_id}) — usado pelo disparo
// agendado em service role (sem contexto de navegador).
export function resolveCampaignPartnerId(campaign: any, senderPartnerId?: string | null): string | null {
  if (senderPartnerId) return senderPartnerId;
  try {
    const parsed = JSON.parse(campaign?.audience_payload || '{}');
    return parsed?.partner_id || null;
  } catch {
    return null;
  }
}

function entitiesOf(client: any) {
  return client?.asServiceRole ? client.asServiceRole.entities : client?.entities;
}

// Verifica a autorização do EMISSOR (User) para disparar/editar a campanha.
// Retorna { authorized: true, partnerId? } ou { authorized: false, reason } —
// o motivo é uma chave técnica (sem PII), própria para log/auditoria seguro.
export async function verifyCampaignSenderAuthorization(
  client: any,
  user: any,
  campaign: any,
  senderPartnerId: string | null = null
): Promise<{ authorized: boolean; reason?: string; partnerId?: string | null }> {
  if (!user) return { authorized: false, reason: 'sender_missing' };
  if (user.account_status === 'deleted') return { authorized: false, reason: 'sender_deleted' };

  // Escopo global: exclusivo do admin.
  if (!campaign?.scope_event_id) {
    return user.role === 'admin'
      ? { authorized: true }
      : { authorized: false, reason: 'global_requires_admin' };
  }

  const audienceType = campaign.audience_type || 'all';
  if (!VALID_AUDIENCE_TYPES.includes(audienceType)) {
    return { authorized: false, reason: 'invalid_audience' };
  }

  // Audiências broadcast (all/segment/manual): gestor do evento (manager/team).
  if (CAMPAIGN_BROADCAST_AUDIENCES.includes(audienceType)) {
    const { authorized } = await verifyEventMembership(client, user, campaign.scope_event_id, EVENT_MANAGER_ROLES);
    return authorized ? { authorized: true } : { authorized: false, reason: 'not_event_manager' };
  }

  // Audiências de emissor (partner/palestrante): a campanha pertence ao emissor.
  if (campaign.sender_user_id && campaign.sender_user_id !== user.id) {
    return { authorized: false, reason: 'not_campaign_sender' };
  }

  if (CAMPAIGN_PARTNER_AUDIENCES.includes(audienceType)) {
    const partnerId = resolveCampaignPartnerId(campaign, senderPartnerId);
    if (!partnerId) return { authorized: false, reason: 'partner_id_missing' };

    const e = entitiesOf(client);
    // Emissor precisa ser rep ativo do parceiro (por user_id ou person_id).
    let isRep = ((await e.PartnerRepresentative.filter({
      partner_id: partnerId, user_id: user.id, is_active: true, is_deleted: false,
    })) || []).length > 0;
    if (!isRep) {
      const persons = await e.Person.filter({ contact_email: user.email, is_active: true });
      if (persons.length > 0) {
        isRep = ((await e.PartnerRepresentative.filter({
          partner_id: partnerId, person_id: persons[0].id, is_active: true, is_deleted: false,
        })) || []).length > 0;
      }
    }
    if (!isRep) return { authorized: false, reason: 'not_partner_rep' };

    // O parceiro precisa estar ativo no evento da campanha.
    const links = await e.EventPartner.filter({
      event_id: campaign.scope_event_id, partner_id: partnerId, is_active: true, is_deleted: false,
    });
    if (links.length === 0) return { authorized: false, reason: 'partner_not_in_event' };

    // E membership ativa em qualquer papel no evento (regra anterior mantida).
    const { authorized } = await verifyAnyEventMembership(client, user, campaign.scope_event_id);
    if (!authorized) return { authorized: false, reason: 'not_event_member' };
    return { authorized: true, partnerId };
  }

  if (audienceType === 'my_attendees') {
    const { authorized } = await verifyEventMembership(client, user, campaign.scope_event_id, ['speaker']);
    return authorized ? { authorized: true } : { authorized: false, reason: 'not_speaker' };
  }

  return { authorized: false, reason: 'invalid_audience' };
}