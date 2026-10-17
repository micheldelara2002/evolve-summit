// manageNotificationCampaign (2026-10-17) — Porta ÚNICA de escrita de campanha
// via SDK do app. Antes, create/update/schedule aconteciam no SDK direto do
// frontend (RLS permitia ao emissor alterar campos críticos da própria
// campanha — inclusive audiência/escopo de uma campanha JÁ AGENDADA). Agora:
//
//   create     → valida escopo/audiência/autorização no SERVIDOR; deriva o
//                emissor do usuário autenticado (nunca do payload); só status
//                'draft'/'scheduled' (com scheduled_at futuro).
//   update     → criador ou admin; scope_type/scope_event_id/sender_user_id
//                IMUTÁVEIS; mudança de audiência recusada em campanha não-draft
//                (aprovação não pode ser trocada silenciosamente); conteúdo
//                editável com sanitização/limites; re-agendamento exige data
//                futura e revalida autorização.
//   delete     → soft delete pelo criador/admin (recusado em 'processing').
//   mark_read  → incrementa read_count idempotente (flip condicional de
//                read_at — exatamente um incremento por destinatário).
//
// A autorização usa o verificador compartilhado (shared/campaignAuth.ts) — o
// mesmo conjunto de regras do disparo manual e do disparo agendado.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from '../../shared/accountSecurity.ts';
import {
  verifyCampaignSenderAuthorization,
  CAMPAIGN_PARTNER_AUDIENCES,
  VALID_AUDIENCE_TYPES,
  EVENT_ALLOWED_SEGMENTS,
  GLOBAL_ALLOWED_SEGMENTS,
} from '../../shared/campaignAuth.ts';

const TITLE_MAX = 80;
const MESSAGE_MAX = 500;

function sanitizeStr(v: any, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

function parseSegments(payload: string | null | undefined): string[] {
  try {
    const arr = JSON.parse(payload || '[]');
    return Array.isArray(arr) ? arr.filter((s: any) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;
    const isAdminUser = user.role === 'admin';

    const body = await req.json().catch(() => ({}));
    const op = String(body.op || '');

    // ===== mark_read: contador idempotente da campanha =====
    if (op === 'mark_read') {
      const { campaign_id } = body;
      if (!campaign_id) return Response.json({ error: 'campaign_id obrigatório.' }, { status: 400 });
      const recs = await svc.entities.NotificationRecipient.filter({
        campaign_id, recipient_user_id: user.id,
      });
      const rec = recs[0];
      if (!rec) return Response.json({ error: 'Notificação não encontrada.' }, { status: 404 });
      if (rec.read_at) return Response.json({ ok: true, already_read: true });
      // Flip condicional (read_at null/ausente → agora): em corrida, exatamente
      // um vencedor — só ele incrementa o contador da campanha.
      const flip = await svc.entities.NotificationRecipient.updateMany(
        { id: rec.id, read_at: null },
        { $set: { read_at: new Date().toISOString() } }
      );
      if (flip && flip.updated) {
        try {
          await svc.entities.NotificationCampaign.updateMany(
            { id: campaign_id },
            { $inc: { read_count: 1 } }
          );
        } catch { /* contador é best-effort */ }
        return Response.json({ ok: true, already_read: false });
      }
      return Response.json({ ok: true, already_read: true });
    }

    // ===== delete: soft delete pelo criador ou admin =====
    if (op === 'delete') {
      const { campaign_id } = body;
      const cs = await svc.entities.NotificationCampaign.filter({ id: campaign_id });
      const campaign = cs[0];
      if (!campaign) return Response.json({ error: 'Campanha não encontrada.' }, { status: 404 });
      const owns = campaign.sender_user_id === user.id || campaign.created_by_id === user.id;
      if (!owns && !isAdminUser) return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      if (campaign.status === 'processing') {
        return Response.json({ error: 'Envio em andamento — aguarde a conclusão.' }, { status: 409 });
      }
      await svc.entities.NotificationCampaign.update(campaign_id, { is_deleted: true });
      return Response.json({ ok: true });
    }

    // ===== create / update =====
    if (op === 'create' || op === 'update') {
      const input = body.campaign || {};
      let campaign: any = null;
      if (op === 'update') {
        const cs = await svc.entities.NotificationCampaign.filter({ id: body.campaign_id });
        campaign = cs[0];
        if (!campaign) return Response.json({ error: 'Campanha não encontrada.' }, { status: 404 });
        if (campaign.is_deleted) return Response.json({ error: 'Campanha não encontrada.' }, { status: 404 });
        const owns = campaign.sender_user_id === user.id || campaign.created_by_id === user.id;
        if (!owns && !isAdminUser) {
          return Response.json({ error: 'Sem permissão para editar esta campanha.' }, { status: 403 });
        }
        if (campaign.status === 'sent') {
          return Response.json({ error: 'Campanha já enviada.' }, { status: 409 });
        }
        if (campaign.status === 'processing') {
          return Response.json({ error: 'Envio em andamento — aguarde a conclusão.' }, { status: 409 });
        }
        // Escopo e emissor são IMUTÁVEIS via update (teste C): o cliente não
        // redireciona a campanha para outro evento nem troca o emissor.
        if (
          (input.scope_event_id !== undefined && (input.scope_event_id || null) !== (campaign.scope_event_id || null)) ||
          (input.scope_type !== undefined && input.scope_type !== campaign.scope_type)
        ) {
          return Response.json(
            { error: 'Escopo da campanha é imutável — crie uma nova campanha.' },
            { status: 400 }
          );
        }
        if (input.sender_user_id !== undefined && input.sender_user_id !== campaign.sender_user_id) {
          return Response.json({ error: 'Emissor é imutável.' }, { status: 400 });
        }
      }

      const scopeType = op === 'update' ? campaign.scope_type : (input.scope_type === 'global' ? 'global' : 'event');
      const scopeEventId = scopeType === 'global' ? null : (op === 'update' ? campaign.scope_event_id : (input.scope_event_id || null));
      if (scopeType === 'global' && !isAdminUser) {
        return Response.json({ error: 'Apenas administradores criam campanhas globais.' }, { status: 403 });
      }
      if (scopeType === 'event' && !scopeEventId) {
        return Response.json({ error: 'scope_event_id é obrigatório para campanhas de evento.' }, { status: 400 });
      }

      // ===== Audiência: mudança recusada fora de rascunho (teste D) =====
      const currentAudienceType = campaign?.audience_type || 'all';
      const currentSegments = parseSegments(campaign?.audience_payload);
      const isSegmentPayload = currentSegments.length > 0 &&
        !(campaign?.audience_type || '').startsWith('partner') && currentAudienceType !== 'my_leads';
      const newAudienceType = input.audience_type !== undefined ? input.audience_type : currentAudienceType;
      const newSegments = Array.isArray(input.audience_segments) ? input.audience_segments.filter((s: any) => typeof s === 'string') : currentSegments;
      const audienceChanged = !campaign ||
        newAudienceType !== currentAudienceType ||
        (newAudienceType === 'segment' && JSON.stringify(newSegments) !== JSON.stringify(currentSegments));

      if (!VALID_AUDIENCE_TYPES.includes(newAudienceType)) {
        return Response.json({ error: 'Audiência inválida.' }, { status: 400 });
      }
      if (audienceChanged && campaign && campaign.status !== 'draft') {
        return Response.json(
          { error: 'A audiência não pode ser alterada em campanhas agendadas/enviadas — crie uma nova campanha.' },
          { status: 409 }
        );
      }

      // Segmentos dentro do escopo (teste E — sem escalação via payload):
      if (newAudienceType === 'segment') {
        const allowed = scopeType === 'global' ? GLOBAL_ALLOWED_SEGMENTS : EVENT_ALLOWED_SEGMENTS;
        const invalid = newSegments.filter((s: string) => !allowed.includes(s));
        if (invalid.length > 0) {
          return Response.json({ error: 'Segmento fora do escopo permitido.' }, { status: 403 });
        }
      }

      // ===== Autorização do emissor (server-side, regras do disparo) =====
      const senderPartnerId = body.senderPartnerId || null;
      const synthetic: any = {
        scope_type: scopeType,
        scope_event_id: scopeEventId,
        audience_type: newAudienceType,
        audience_payload: CAMPAIGN_PARTNER_AUDIENCES.includes(newAudienceType) && senderPartnerId
          ? JSON.stringify({ partner_id: senderPartnerId })
          : (campaign?.audience_payload || null),
        sender_user_id: campaign?.sender_user_id || user.id,
      };
      const verdict = await verifyCampaignSenderAuthorization(base44, user, synthetic, senderPartnerId);
      if (!verdict.authorized) {
        return Response.json(
          { error: 'Sem permissão para este escopo/audiência.', reason: verdict.reason },
          { status: 403 }
        );
      }

      // ===== Conteúdo (sanitizado e limitado) =====
      const content = {
        title: sanitizeStr(input.title !== undefined ? input.title : campaign?.title, TITLE_MAX),
        message: sanitizeStr(input.message !== undefined ? input.message : campaign?.message, MESSAGE_MAX),
        type: ['informativa', 'lembrete', 'destaque'].includes(input.type ?? campaign?.type)
          ? (input.type ?? campaign?.type ?? 'informativa')
          : 'informativa',
        priority: ['low', 'normal', 'high'].includes(input.priority ?? campaign?.priority)
          ? (input.priority ?? campaign?.priority ?? 'normal')
          : 'normal',
        cta_label: sanitizeStr(input.cta_label !== undefined ? input.cta_label : campaign?.cta_label, 40),
        cta_target: sanitizeStr(input.cta_target !== undefined ? input.cta_target : campaign?.cta_target, 200),
      };
      if (!content.title || !content.message) {
        return Response.json({ error: 'Título e mensagem são obrigatórios.' }, { status: 400 });
      }

      // ===== Agendamento =====
      let status: string = campaign?.status || 'draft';
      let scheduled_at: string | null = campaign?.scheduled_at || null;
      if (input.scheduled_at !== undefined) {
        if (input.scheduled_at === null) {
          scheduled_at = null;
          if (campaign && campaign.status === 'scheduled') status = 'draft';
        } else {
          const t = Date.parse(input.scheduled_at);
          if (!Number.isFinite(t)) {
            return Response.json({ error: 'Data de agendamento inválida.' }, { status: 400 });
          }
          if (t <= Date.now()) {
            return Response.json({ error: 'A data do agendamento deve ser futura.' }, { status: 400 });
          }
          scheduled_at = new Date(t).toISOString();
          status = 'scheduled';
        }
      }
      if (status === 'scheduled' && !scheduled_at) {
        return Response.json({ error: 'Campanha agendada exige scheduled_at.' }, { status: 400 });
      }

      // ===== Persistência (service role; RLS de escrita direta é admin-only) =====
      const partnerAud = CAMPAIGN_PARTNER_AUDIENCES.includes(newAudienceType);
      const audience_payload = newAudienceType === 'segment'
        ? JSON.stringify(newSegments)
        : (partnerAud
          ? JSON.stringify({ partner_id: verdict.partnerId || senderPartnerId || '' })
          : null);

      if (op === 'create') {
        const doc = await svc.entities.NotificationCampaign.create({
          ...content,
          scope_type: scopeType,
          scope_event_id: scopeEventId || undefined,
          sender_user_id: user.id,
          sender_role: isAdminUser ? 'admin' : (partnerAud ? 'representante' : undefined),
          audience_type: newAudienceType,
          audience_payload,
          status,
          scheduled_at,
        });
        return Response.json({ ok: true, campaign: doc });
      }

      // ===== Item 1 (2026-10-17) — invalidação de aprovação agendada =====
      // Mudança de conteúdo em campanha AGENDADA não preserva a aprovação
      // antiga: a autorização já foi revalidada acima (verdict) e será
      // revalidada de novo no disparo; o contador de tentativas automáticas é
      // RESETADO (nova janela de aprovação) e a edição fica em auditoria.
      // Audiência/escopo/emissor continuam imutáveis (recusados acima).
      const contentChanged =
        content.title !== campaign.title ||
        content.message !== campaign.message ||
        content.type !== campaign.type ||
        content.priority !== campaign.priority ||
        (content.cta_label || '') !== (campaign.cta_label || '') ||
        (content.cta_target || '') !== (campaign.cta_target || '');
      const wasScheduled = !!(campaign.scheduled_at && campaign.status !== 'draft');
      const updateData: any = { ...content, audience_type: newAudienceType, audience_payload, status, scheduled_at };
      if (contentChanged && wasScheduled) updateData.auto_dispatch_attempts = 0;

      const doc = await svc.entities.NotificationCampaign.update(campaign.id, updateData);
      if (contentChanged && wasScheduled) {
        try {
          await svc.entities.AuditLog.create({
            action: 'update',
            entity_type: 'NotificationCampaign',
            entity_id: campaign.id,
            user_id: user.id,
            details: JSON.stringify({ type: 'scheduled_campaign_edited', attempts_reset: true }),
          });
        } catch { /* best-effort */ }
      }
      return Response.json({ ok: true, campaign: doc });
    }

    return Response.json({ error: 'Operação inválida.' }, { status: 400 });
  } catch (error: any) {
    console.error('[manageNotificationCampaign]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}