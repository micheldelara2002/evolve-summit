// =============================================================================
// countCampaignAudience — P0 (2026-09-29)
// Contagem EXATA de destinatários para a audiência selecionada no criador de
// campanhas (regra de negócio aprovada). Usa a MESMA resolução de audiência do
// disparo (shared/campaignAudience — extraída do dispatchNotificationCampaign)
// em modo count-only: zero duplicação de lógica, zero writes.
//
// Conta apenas destinatários com conta de app (recipient_user_id = User ID) —
// mesma semântica do disparo. Autorização espelha o dispatch.
//
// Memória: dedup por user_id exige O(destinatários) no Set — bounded pelo
// tamanho da audiência e sem escrita; leitura paginada via scanBatches.
// Orçamento de tempo por invocação: se exceder, retorna a contagem parcial com
// complete=false (o frontend exibe "N+").
// =============================================================================
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { requireActiveUser } from '../../shared/accountSecurity.ts';
import { verifyEventMembership, verifyAnyEventMembership, EVENT_MANAGER_ROLES } from '../../shared/eventAuth.ts';
import { resolveAudienceBatches } from '../../shared/campaignAudience.ts';

const TIME_BUDGET_MS = 15_000;

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { scopeEventId, audienceType, audienceSegments = [], senderPartnerId } =
      await req.json().catch(() => ({}));
    const effectiveType = audienceType || 'all';

    // === Autorização — espelha dispatchNotificationCampaign ===
    if (scopeEventId) {
      const broadcastAudiences = ['all', 'segment', 'manual'];
      if (broadcastAudiences.includes(effectiveType)) {
        const canDispatch = await verifyEventMembership(base44, user, scopeEventId, EVENT_MANAGER_ROLES);
        if (!canDispatch.authorized) {
          return Response.json({ error: 'Sem permissão para esta audiência.' }, { status: 403 });
        }
      } else {
        const partnerAudiences = ['my_leads', 'partner_leads', 'partner_all_event'];
        if (partnerAudiences.includes(effectiveType) && senderPartnerId) {
          let repRecords = await base44.asServiceRole.entities.PartnerRepresentative.filter({
            partner_id: senderPartnerId, user_id: user.id, is_active: true, is_deleted: false,
          });
          if (repRecords.length === 0) {
            const persons = await base44.asServiceRole.entities.Person.filter({ contact_email: user.email, is_active: true });
            if (persons.length > 0) {
              repRecords = await base44.asServiceRole.entities.PartnerRepresentative.filter({
                partner_id: senderPartnerId, person_id: persons[0].id, is_active: true, is_deleted: false,
              });
            }
          }
          if (repRecords.length === 0) {
            return Response.json({ error: 'senderPartnerId não pertence ao usuário autenticado.' }, { status: 403 });
          }
          const eventPartners = await base44.asServiceRole.entities.EventPartner.filter({
            event_id: scopeEventId, partner_id: senderPartnerId, is_active: true, is_deleted: false,
          });
          if (eventPartners.length === 0) {
            return Response.json({ error: 'Partner não está associado a este evento.' }, { status: 403 });
          }
        }
        const hasAnyMembership = await verifyAnyEventMembership(base44, user, scopeEventId);
        if (!hasAnyMembership.authorized) {
          return Response.json({ error: 'Sem permissão para esta audiência.' }, { status: 403 });
        }
      }
    } else if (user.role !== 'admin') {
      return Response.json({ error: 'Apenas administradores podem usar audiências globais.' }, { status: 403 });
    }

    // === Contagem exata — mesma resolução de audiência do disparo ===
    const svc = base44.asServiceRole;
    const seen = new Set<string>();
    let count = 0;
    let complete = true;
    const start = Date.now();

    for await (const { recipients } of resolveAudienceBatches(svc, {
      scopeType: scopeEventId ? 'event' : 'global',
      scopeEventId: scopeEventId || null,
      audienceType: effectiveType,
      audienceSegments,
      senderUser: user,
      senderPartnerId: senderPartnerId || null,
    })) {
      for (const r of recipients) {
        if (r.user_id && !seen.has(r.user_id)) {
          seen.add(r.user_id);
          count++;
        }
      }
      if (Date.now() - start >= TIME_BUDGET_MS) {
        complete = false;
        break;
      }
    }

    return Response.json({ ok: true, count, complete });
  } catch (error) {
    console.error('countCampaignAudience error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}