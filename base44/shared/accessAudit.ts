// F3-13 (2026-11-12) — TRILHA DE MUDANÇA DE ACESSO (concessão/alteração/revogação).
//
// Motivo: a revisão da Fase 3 encontrou concessões de acesso fora do
// manageParticipant (convite de equipe/gerente/curador, aceite de convite,
// promoção a palestrante pela curadoria, associação de representante de parceiro)
// sem qualquer trilha. Um papel concedido sem registro não é rastreável.
//
// Diferente de `manageParticipant` (que NEGA a resposta quando não consegue
// auditar), aqui a operação de acesso NÃO é revertida: convite, aprovação de
// palestra e vínculo de parceiro são fluxos legítimos e bloqueá-los por falha de
// log criaria um defeito pior (convite não sai, palestrante não é aprovado).
// O que NUNCA acontece é declarar auditado sem evidência:
//   • trilha principal gravada e confirmada → 'recorded';
//   • pendência gravada e RELIDA por leitura  → 'pending' (reconciliada por
//     resolvePendingTrails com a mesma chave);
//   • nada persistido                         → 'unavailable' (o chamador informa).
// A identidade vem sempre do ator autenticado passado pelo backend; nunca do
// corpo da requisição.

import { buildAuditKey, writeMandatoryAudit, recordPendingTrailVerified } from "./auditTrail.ts";

export type AccessAuditState = "recorded" | "pending" | "unavailable";

export interface AccessAuditInput {
  eventId: string;
  /** Entidade alterada: EventMembership, Participant, PartnerRepresentative. */
  entityType: string;
  entityId?: string;
  /** Ator autenticado (do servidor). Ausente = operação do sistema. */
  actor?: { id?: string; full_name?: string; email?: string } | null;
  /** Operação da chave: role_grant, role_revoke, invite_accepted, role_change. */
  operation: string;
  /** Referência determinística da ocorrência (membership, convite, participante). */
  reference: string;
  details?: Record<string, any>;
}

export async function recordAccessChange(
  svc: any,
  { eventId, entityType, entityId, actor, operation, reference, details }: AccessAuditInput,
): Promise<AccessAuditState> {
  const entry: Record<string, any> = {
    event_id: eventId || "",
    action: "role_change",
    entity_type: entityType,
    entity_id: entityId || "",
    user_id: actor?.id || "system",
    user_name: actor?.full_name || actor?.email || "Sistema",
    details: JSON.stringify(details || {}),
    audit_key: buildAuditKey(operation, reference),
  };

  try {
    await writeMandatoryAudit(svc, entry);
    return "recorded";
  } catch (err: any) {
    const failure = err?.message || String(err);
    const pending = await recordPendingTrailVerified(svc, {
      ...entry,
      provider: "base44",
      failure_reason: failure,
    });
    return pending ? "pending" : "unavailable";
  }
}