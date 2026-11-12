import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { extractClientIp } from "../../shared/commerceAudit.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";
import { recordClientAudit } from "../../shared/auditLogger.ts";

// F3-08 (rodada de correção 2026-11-12) — LOGGER AUXILIAR de auditoria.
//
// Esta função NÃO registra operação crítica. A decisão sobre o que pode ser
// gravado pelo cliente (ações permitidas, entidades críticas recusadas, escopo
// do `entity_id` conferido no evento) vive em `shared/auditLogger.ts`, junto do
// caminho único de escrita.
//
// Operações críticas são auditadas pelo backend que as executa:
//   • role_change de participante/equipe → manageParticipant
//   • emissão de certificado             → issueCertificate
//   • pagamento, estorno, repasse, comércio → commerceAudit / writeMandatoryAudit
//
// Aqui ficam apenas: (1) guard de conta ativa, (2) gate de gestão do evento e
// (3) a chamada do logger, que deriva autor/escopo do contexto autenticado.
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const eventId = typeof body?.event_id === 'string' ? body.event_id.trim() : '';

    // Gate de escopo: admin OU gestão do evento (manager/team). Participante
    // não escreve auditoria; a leitura continua admin-only pela RLS.
    if (eventId) {
      if (!/^[0-9a-f]{24}$/i.test(eventId)) {
        return Response.json({ error: 'event_id inválido.' }, { status: 400 });
      }
      const gate = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
      if (!gate.authorized) {
        return Response.json({ error: 'Somente a gestão do evento pode registrar auditoria.' }, { status: 403 });
      }
    } else if (user.role !== 'admin') {
      return Response.json({ error: 'Sem permissão para registrar auditoria sem escopo de evento.' }, { status: 403 });
    }

    const result = await recordClientAudit(base44.asServiceRole, {
      user,
      eventId,
      ip: extractClientIp(req),
      body,
    });

    if (!result.ok) {
      return Response.json({ error: result.error }, { status: result.status });
    }

    return Response.json({ ok: true, id: result.record?.id || '' });
  } catch (error: any) {
    // O logger é best-effort no cliente, mas a falha nunca é silenciosa aqui.
    console.error("logAuditEvent error:", error?.message || error);
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}