// SONDA TEMPORÁRIA — remover após a validação de P0-B.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import {
  buildAuditKey,
  writeMandatoryAudit,
  recordPendingTrail,
  resolvePendingTrails,
} from "../../shared/auditTrail.ts";

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const results: any[] = [];
  const stamp = Date.now();
  const created: string[] = [];

  try {
    // 1) Idempotência: mesma chave duas vezes → uma trilha, segunda é replay.
    const key = buildAuditKey('checkout_iniciado', `ZZPROBE-${stamp}`);
    const entry = {
      action: 'create', entity_type: 'Order', entity_id: `probe-${stamp}`,
      user_id: 'system', user_name: 'Sonda P0-B', audit_key: key,
      provider: 'stripe', amount: 10, details: JSON.stringify({ type: 'probe_p0b' }),
    };
    const a = await writeMandatoryAudit(svc, entry);
    const b = await writeMandatoryAudit(svc, entry);
    created.push(a.id);
    const rows = await svc.entities.AuditLog.filter({ audit_key: key });
    results.push({
      test: 'idempotencia_da_trilha',
      ok: a.duplicate === false && b.duplicate === true && a.id === b.id && rows.length === 1,
      detail: { first: a, second: b, registros: rows.length },
    });

    // 2) Falha de escrita ANTES do efeito externo → AuditUnavailableError.
    const broken = {
      entities: {
        AuditLog: {
          filter: async () => { throw new Error('db indisponivel'); },
          create: async () => { throw new Error('db indisponivel'); },
        },
      },
    };
    let thrown = '';
    try {
      await writeMandatoryAudit(broken as any, { ...entry, audit_key: buildAuditKey('checkout_iniciado', `ZZBROKEN-${stamp}`) });
    } catch (err: any) {
      thrown = err?.name || 'erro';
    }
    results.push({ test: 'bloqueio_antes_do_efeito', ok: thrown === 'AuditUnavailableError', detail: thrown });

    // 3) Caso pendente (efeito externo ocorrido) → reconciliação conclui.
    const pendKey = buildAuditKey('pagamento_confirmado', `ZZPROBE-${stamp}`);
    const pendingId = await recordPendingTrail(svc, {
      action: 'status_change', entity_type: 'Payment', entity_id: `probe-pay-${stamp}`,
      audit_key: pendKey, provider: 'stripe', external_reference: `pi_probe_${stamp}`,
      amount: 25, failure_reason: 'falha simulada de trilha',
      details: JSON.stringify({ type: 'pagamento_confirmado' }),
    });
    const pendingRow = (await svc.entities.AuditLog.filter({ audit_key: `${pendKey}|pending` }))[0];
    if (pendingRow) created.push(pendingRow.id);
    const reco = await resolvePendingTrails(svc, 50);
    const after = (await svc.entities.AuditLog.filter({ audit_key: `${pendKey}|pending` }))[0];
    const trail = (await svc.entities.AuditLog.filter({ audit_key: pendKey }))[0];
    if (trail) created.push(trail.id);
    results.push({
      test: 'caso_pendente_e_reconciliacao',
      ok: !!pendingId && after?.status === 'resolved' && !!trail && (reco.resolved + reco.failed) > 0,
      detail: { pendingId, statusFinal: after?.status, trilhaRegravada: !!trail, reconciliacao: reco },
    });
  } catch (err: any) {
    results.push({ test: 'execucao', ok: false, detail: err?.message || String(err) });
  } finally {
    for (const id of created) {
      try { await svc.entities.AuditLog.delete(id); } catch { /* já removido */ }
    }
  }

  return Response.json({ allOk: results.every((r) => r.ok), results });
}