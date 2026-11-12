import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { EVENT_FINANCE_FIELDS } from "../../shared/eventFinance.ts";
import { buildAuditKey, writeMandatoryAudit } from "../../shared/auditTrail.ts";

/**
 * migrateEventFinance — Fase 2 (2026-11-12)
 *
 * Copia os campos financeiros internos do Event para EventFinance e ESVAZIA os
 * campos legados no Event. Só depois disto a entidade Event deixa de expor
 * comissão, conta recebedora, política de estorno e códigos de cupom a qualquer
 * usuário autenticado (a RLS de Event permite leitura de eventos ativos).
 *
 * Enquanto a migração não roda, o código lê das duas fontes
 * (shared/eventFinance.ts: financeiro → legado) e nada quebra — a exposição,
 * porém, continua existindo para os eventos antigos.
 *
 * Regras:
 *   - admin apenas (é alteração de dados em massa, não operação de rotina);
 *   - idempotente: documento já existente é preservado, campo já vazio é no-op;
 *   - paginada por id (scan) — nunca carrega a coleção inteira;
 *   - `dry_run: true` (padrão) NÃO altera nada: relata o que faria;
 *   - cada evento migrado gera trilha obrigatória com a chave determinística
 *     event_finance_migrado|<eventId>, então repetir não duplica registro.
 *
 * Payload: { dry_run?: boolean, limit?: number, eventId?: string }
 */
export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    // Operação administrativa de dados: role admin (não membership de evento).
    if (user.role !== 'admin') {
      return Response.json({ error: 'Apenas administradores podem migrar a configuração financeira dos eventos.' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dry_run !== false;
    const singleEventId = typeof body?.eventId === 'string' && body.eventId ? body.eventId : '';
    let limit = Number(body?.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    limit = Math.min(Math.floor(limit), 500);

    const svc = base44.asServiceRole;

    const query: any = { is_deleted: false };
    if (singleEventId) query.id = singleEventId;

    const page = await svc.entities.Event.filter(query, { sort: 'created_date', limit });
    const events = page.items || page;

    let created = 0;
    let merged = 0;
    let alreadyClean = 0;
    let failed = 0;
    const details: any[] = [];

    for (const event of events) {
      const legacy: any = {};
      for (const field of EVENT_FINANCE_FIELDS) {
        const v = event[field];
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v) && v.length === 0) continue;
        legacy[field] = v;
      }

      const existing = (await svc.entities.EventFinance.filter({ event_id: event.id }))[0] || null;

      if (!existing && Object.keys(legacy).length === 0) {
        alreadyClean++;
        continue;
      }

      if (dryRun) {
        details.push({
          event_id: event.id,
          name: event.name,
          action: existing ? 'merge_legacy_into_existing' : 'create',
          fields: Object.keys(legacy),
        });
        if (existing) merged++; else created++;
        continue;
      }

      try {
        let financeId = existing?.id || '';
        if (!financeId) {
          const doc = await svc.entities.EventFinance.create({ event_id: event.id, ...legacy });
          financeId = doc.id;
          created++;
        } else if (Object.keys(legacy).length > 0) {
          // Só completa o que estiver vazio no documento financeiro — valor já
          // configurado na entidade nova é a fonte da verdade e não é sobrescrito.
          const patch: any = {};
          for (const [field, value] of Object.entries(legacy)) {
            const current = (existing as any)[field];
            const isEmpty = current === undefined || current === null || current === ''
              || (Array.isArray(current) && current.length === 0);
            if (isEmpty) patch[field] = value;
          }
          if (Object.keys(patch).length > 0) {
            await svc.entities.EventFinance.update(financeId, patch);
            merged++;
          }
        }

        // Esvazia o legado no Event — é o que fecha a exposição.
        const clear = {
          commission_percent: null,
          payout_account_id: '',
          refund_policy: '',
          coupon_codes_registry: [],
        };
        await svc.entities.Event.update(event.id, clear);

        try {
          await writeMandatoryAudit(svc, {
            action: 'update',
            entity_type: 'EventFinance',
            entity_id: financeId,
            user_id: user.id,
            user_name: user.full_name || user.email || '',
            event_id: event.id,
            audit_key: buildAuditKey('event_finance_migrado', event.id),
            provider: 'internal',
            amount: 0,
            details: JSON.stringify({
              type: 'event_finance_migrado',
              event_id: event.id,
              campos: Object.keys(legacy),
              criado: !existing,
            }),
          });
        } catch (auditErr: any) {
          console.error('[migrateEventFinance] trilha indisponível:', event.id, auditErr?.message || auditErr);
        }
        details.push({ event_id: event.id, name: event.name, action: existing ? 'merge' : 'create', fields: Object.keys(legacy) });
      } catch (err: any) {
        failed++;
        details.push({ event_id: event.id, name: event.name, action: 'failed', error: err?.message || String(err) });
        console.error('[migrateEventFinance] falha no evento:', event.id, err?.message || err);
      }
    }

    return Response.json({
      ok: true,
      dry_run: dryRun,
      scanned: events.length,
      created,
      merged,
      already_clean: alreadyClean,
      failed,
      has_more: !!(page?.has_more || (page?.next_cursor && !singleEventId)),
      next_cursor: page?.next_cursor || null,
      details,
    });
  } catch (error: any) {
    console.error('[migrateEventFinance]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}