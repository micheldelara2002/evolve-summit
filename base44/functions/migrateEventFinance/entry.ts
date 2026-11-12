import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { migrateEventFinanceBatch } from "../../shared/eventFinanceMigration.ts";

/**
 * migrateEventFinance — Fase 2 (2026-11-12)
 *
 * Copia os campos financeiros internos do Event para EventFinance e ESVAZIA o
 * legado no Event. A lógica (ordem das operações, confirmação, trilha
 * obrigatória e cursor) vive em shared/eventFinanceMigration.ts — esta função só
 * autentica, valida o payload e responde.
 *
 * Payload: {
 *   dry_run?: boolean,   // padrão true — nada é alterado
 *   cursor?: string,     // devolvido em next_cursor; retoma do ponto correto
 *   limit?: number,      // lote (padrão 200, máx 500)
 *   eventId?: string,    // migra um único evento (ignora cursor)
 * }
 *
 * Resposta: ok, dry_run, mode, complete, scanned, created, merged,
 * cleared_only, already_clean, failed, audit_failures, has_more, next_cursor,
 * retry_page, cursor_used, failures[], details[].
 *
 * `retry_page: true` ⇒ houve falha nesta página e `next_cursor` é o cursor de
 * ENTRADA: reenviar esse cursor relê a mesma página (eventos já migrados são
 * no-op) — nenhum evento é pulado.
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

    const result = await migrateEventFinanceBatch(base44.asServiceRole, {
      dryRun: body?.dry_run !== false,
      cursor: typeof body?.cursor === 'string' ? body.cursor : null,
      limit: body?.limit,
      eventId: typeof body?.eventId === 'string' ? body.eventId : '',
      actor: { id: user.id, name: user.full_name || user.email || '' },
    });

    return Response.json(result);
  } catch (error: any) {
    console.error('[migrateEventFinance]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}