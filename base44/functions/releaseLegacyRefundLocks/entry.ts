import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { buildAuditKey, writeMandatoryAudit } from "../../shared/auditTrail.ts";
import { extractClientIp } from "../../shared/commerceAudit.ts";

// P0.2 (2026-11-12) — RECUPERAÇÃO EXPLÍCITA DE TRAVAS LEGADAS.
//
// O caminho normal de liberação (unlockTicketsForRefund) passou a exigir o
// dono da trava (refund_request_id) e o fallback genérico foi REMOVIDO: uma
// solicitação nova nunca libera ingresso de outra, nem ingresso legado sem
// carimbo. Isso deixa um único resíduo possível: ingressos que ficaram em
// 'refund_pending' SEM dono (travados por versões anteriores ao carimbo, ou
// por um crash antes da gravação do dono). Eles não podem ficar presos para
// sempre — bloqueiam check-in e não pertencem a nenhuma solicitação.
//
// Esta é a porta SEPARADA e auditável para esse resíduo:
//   - admin-only (nunca gerente, nunca comprador);
//   - escopo obrigatório e delimitado (um pedido ou um ingresso específico);
//   - só toca ingresso 'refund_pending' SEM dono;
//   - recusa o pedido inteiro se existir solicitação 'pending' viva nele (a
//     solicitação em andamento é quem decide o destino dos ingressos);
//   - dry-run por padrão (só altera com apply: true) e trilha obrigatória por
//     ingresso liberado.
//
// Payload: { ticket_id? , order_id?, reason, apply? }

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    if (user.role !== "admin") {
      return Response.json({ error: "Somente o administrador pode liberar travas de estorno legadas." }, { status: 403 });
    }

    const svc = base44.asServiceRole;
    const clientIp = extractClientIp(req);
    const body = await req.json().catch(() => ({}));
    const { ticket_id, order_id, reason, apply = false } = body || {};

    if (!ticket_id && !order_id) {
      return Response.json({ error: "Informe ticket_id ou order_id (escopo delimitado)." }, { status: 400 });
    }
    if (!reason || String(reason).trim().length < 10) {
      return Response.json({ error: "Informe o motivo (mínimo 10 caracteres) — fica na trilha de auditoria." }, { status: 400 });
    }

    // Alvos: SOMENTE refund_pending sem dono.
    const query: any = {
      status: "refund_pending",
      is_deleted: false,
      $or: [{ refund_request_id: { $exists: false } }, { refund_request_id: null }],
    };
    if (ticket_id) query.id = String(ticket_id);
    if (order_id) query.order_id = String(order_id);

    const tickets = await svc.entities.Ticket.filter(query, "created_date", 200);
    const targets = ticket_id ? tickets.filter((t: any) => t.id === ticket_id) : tickets;

    const result = {
      ok: true,
      applied: !!apply,
      examined: targets.length,
      released: 0,
      skipped: 0,
      details: [] as any[],
    };
    if (targets.length === 0) return Response.json(result);

    // Pedidos com solicitação viva: os ingressos pertencem ao fluxo em andamento.
    const orderIds = [...new Set(targets.map((t: any) => t.order_id).filter(Boolean))];
    const liveOrders = new Set<string>();
    for (const oid of orderIds) {
      const pend = await svc.entities.RefundRequest.filter({ order_id: oid, status: "pending", is_deleted: false });
      if (pend.length > 0) liveOrders.add(String(oid));
    }

    for (const t of targets) {
      if (liveOrders.has(String(t.order_id))) {
        result.skipped++;
        result.details.push({ ticket_id: t.id, skipped: "solicitação de estorno em andamento no pedido" });
        continue;
      }
      if (!apply) {
        result.details.push({ ticket_id: t.id, order_id: t.order_id, release: "dry-run" });
        continue;
      }
      // CAS: só libera se ainda estiver refund_pending e SEM dono.
      const claim = await svc.entities.Ticket.updateMany(
        {
          id: t.id,
          status: "refund_pending",
          $or: [{ refund_request_id: { $exists: false } }, { refund_request_id: null }],
        },
        { $set: { status: "issued", refund_request_id: null } },
      );
      if (!claim || !claim.updated) {
        result.skipped++;
        result.details.push({ ticket_id: t.id, skipped: "estado mudou durante a operação" });
        continue;
      }
      // Trilha obrigatória por ingresso liberado: sem trilha confirmada o
      // ingresso volta para refund_pending (nada é liberado sem evidência).
      try {
        await writeMandatoryAudit(svc, {
          action: "status_change",
          entity_type: "Ticket",
          entity_id: t.id,
          user_id: user.id,
          user_name: user.full_name || "",
          event_id: t.event_id || "",
          ip_address: clientIp,
          audit_key: buildAuditKey("trava_legada_liberada", t.id),
          provider: "manual",
          amount: 0,
          details: JSON.stringify({
            type: "trava_legada_liberada",
            ticket_id: t.id,
            order_id: t.order_id || "",
            order_item_id: t.order_item_id || "",
            motivo: String(reason).trim(),
            observacao: "Trava de estorno sem dono liberada por administrador.",
          }),
        });
      } catch (auditErr: any) {
        try {
          await svc.entities.Ticket.updateMany(
            { id: t.id, status: "issued", $or: [{ refund_request_id: { $exists: false } }, { refund_request_id: null }] },
            { $set: { status: "refund_pending" } },
          );
        } catch {}
        result.skipped++;
        result.details.push({ ticket_id: t.id, skipped: "trilha de auditoria indisponível — nada foi alterado" });
        console.error("[releaseLegacyRefundLocks] trilha indisponível:", t.id, auditErr?.message || auditErr);
        continue;
      }
      result.released++;
      result.details.push({ ticket_id: t.id, order_id: t.order_id, released: true });
    }

    return Response.json(result);
  } catch (error: any) {
    console.error('[releaseLegacyRefundLocks]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}