// P1-04 (AUD-03) — PRIMITIVA ÚNICA de alteração de papel de Participant.
//
// PROBLEMA CORRIGIDO: o `manageParticipant` tinha a porta de integridade
// (gate → evidência → claim CAS → confirmação por leitura → trilha obrigatória →
// liberação), mas OUTROS caminhos escreviam `role_in_event` diretamente, cada um
// com uma trilha diferente — ou sem trilha nenhuma:
//   • manageSubmission (aprovação → speaker, cancelamento → attendee);
//   • associateEventPartner (representante → partner_rep e criação privilegiada);
//   • manageParticipant removeStaff (team → attendee);
//   • shared/eventInvites (aceite de convite → team/manager).
//
// Aqui vive UMA implementação desse ciclo, usada por todos eles. O chamador
// continua responsável pela AUTORIZAÇÃO (quem pode pedir a alteração); esta
// primitiva garante o resto: validação de escopo/estado, gate de pendência,
// evidência durável ANTES da mutação, claim atômico por CAS no mesmo documento,
// prova da mutação por leitura, trilha obrigatória com chave determinística e
// liberação do claim apenas com trilha CONFIRMADA.
//
// Concorrência (limitação real da plataforma, declarada): não há transação entre
// documentos. A garantia é a atomicidade da atualização CONDICIONAL de UM
// documento ({ role_change_locked: { $ne: true } }) somada à confirmação por
// leitura — a mesma primitiva já usada em checkout_lock, lead_reservation_tokens
// e devolução de estoque.

import {
  buildAuditKey,
  writeMandatoryAudit,
  recordPendingTrailVerified,
  readAuditByKey,
} from "./auditTrail.ts";

export type AccessAuditState = "recorded" | "pending" | "unavailable";

/** Prova de mutação: token da ocorrência gravado NA MESMA escrita do papel. */
export const ROLE_TOKEN_FIELD = "last_role_change_occurrence";
/** Claim da alteração em andamento (CAS { $ne: true }). */
export const ROLE_LOCK_FIELD = "role_change_locked";
/** Ocorrência aplicada cuja trilha ainda não foi confirmada. */
export const ROLE_PENDING_FIELD = "role_audit_pending";

const EVIDENCE_ENTITY = "AccessChangeEvidence";

export function newOccurrence(prefix: string): string {
  const token = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${token}`;
}

function msg(err: any): string {
  return err?.message || String(err);
}

async function createEvidence(svc: any, data: Record<string, any>): Promise<any> {
  const created = await svc.entities[EVIDENCE_ENTITY].create({ ...data, is_deleted: false });
  if (!created?.id) throw new Error("evidência não confirmou a gravação");
  return created;
}

export async function markEvidence(svc: any, evidenceId: string, patch: Record<string, any>): Promise<void> {
  if (!evidenceId) return;
  try {
    await svc.entities[EVIDENCE_ENTITY].update(evidenceId, patch);
  } catch (err: any) {
    console.error("[roleChange] falha ao atualizar evidência:", msg(err));
  }
}

export function evidenceStateFor(auditState: AccessAuditState | string): string {
  if (auditState === "recorded") return "audit_recorded";
  if (auditState === "pending") return "audit_pending";
  return "audit_unavailable";
}

/**
 * Trilha OBRIGATÓRIA da alteração de papel. Chave determinística
 * (role_change|occurrence): retry, replay e recuperações simultâneas convergem
 * para um único registro. Falha de gravação vira pendência persistida e RELIDA;
 * sem confirmação de nenhuma das duas, o retorno é 'unavailable' — nunca
 * 'recorded' por suposição.
 */
export async function auditRoleChange(
  svc: any,
  actor: { id?: string; full_name?: string; email?: string } | null,
  eventId: string,
  { entityType = "Participant", entityId = "", occurrence = "", details = {} as Record<string, any> },
): Promise<AccessAuditState> {
  const entry: Record<string, any> = {
    event_id: eventId || "",
    action: "role_change",
    entity_type: entityType,
    entity_id: entityId || "",
    user_id: actor?.id || "system",
    user_name: actor?.full_name || actor?.email || "Sistema",
    details: JSON.stringify(details || {}),
    ip_address: "",
    audit_key: buildAuditKey("role_change", occurrence || `${entityType}:${entityId || "sem_id"}`),
  };
  try {
    await writeMandatoryAudit(svc, entry);
    return "recorded";
  } catch (err: any) {
    const pending = await recordPendingTrailVerified(svc, {
      ...entry,
      provider: "base44",
      failure_reason: msg(err),
    });
    return pending ? "pending" : "unavailable";
  }
}

/**
 * Reconciliação EVIDÊNCIA × ESTADO PERSISTIDO. 'started' NÃO é prova de mutação:
 * exige o token da própria ocorrência gravado pelo escrita do papel.
 */
export function reconcileRoleEvidence(participant: any, evidence: any) {
  const token = String(participant?.[ROLE_TOKEN_FIELD] || "");
  const occurrence = String(evidence?.occurrence || "");
  const persistedRole = String(participant?.role_in_event || "");
  const expectedRole = String(evidence?.new_value || "");
  const state = String(evidence?.state || "");

  if (state === "started") {
    if (!token) return { applied: false, classification: "nao_aplicada" };
    if (token !== occurrence) return { applied: false, classification: "superada_por_ocorrencia_posterior" };
    if (persistedRole !== expectedRole) return { applied: false, classification: "estado_divergente" };
    return { applied: true, classification: "mutacao_aplicada_evidencia_nao_atualizada" };
  }
  if (persistedRole !== expectedRole) return { applied: false, classification: "estado_divergente" };
  return { applied: true, classification: "mutacao_aplicada" };
}

export function rolePendingOf(participant: any): string {
  return String(participant?.[ROLE_PENDING_FIELD] || "");
}

/** Libera o claim SOMENTE da ocorrência dona (CAS pelo token pendente) + leitura. */
export async function releaseRoleLock(
  svc: any,
  participantId: string,
  eventId: string,
  occurrence: string,
): Promise<boolean> {
  const token = String(occurrence || "");
  if (!token) return false;
  try {
    await svc.entities.Participant.updateMany(
      { id: participantId, event_id: eventId, [ROLE_PENDING_FIELD]: token },
      { $set: { [ROLE_LOCK_FIELD]: false, [ROLE_PENDING_FIELD]: "" } },
    );
  } catch (err: any) {
    console.error("[roleChange] falha ao liberar claim de papel:", msg(err));
    return false;
  }
  try {
    const rows = await svc.entities.Participant.filter({ id: participantId, event_id: eventId });
    const row = rows?.[0] || null;
    return !!row && String(row[ROLE_PENDING_FIELD] || "") !== token;
  } catch {
    return false;
  }
}

export type RoleGateState = "clear" | "blocked" | "unavailable";

/**
 * Porta de integridade: uma alteração anterior sem trilha CONFIRMADA bloqueia a
 * próxima. Só a leitura que ENCONTRA a trilha libera — nunca suposição.
 */
export async function roleChangeGate(
  svc: any,
  participant: any,
  eventId: string,
): Promise<{ state: RoleGateState; released: boolean; pending: string }> {
  const pending = rolePendingOf(participant);
  if (!pending) return { state: "clear", released: false, pending: "" };
  const trail = await readAuditByKey(svc, buildAuditKey("role_change", pending));
  if (trail.state === "unavailable") return { state: "unavailable", released: false, pending };
  if (trail.state === "absent") return { state: "blocked", released: false, pending };
  const released = await releaseRoleLock(svc, participant.id, eventId, pending);
  return released
    ? { state: "clear", released: true, pending }
    : { state: "blocked", released: false, pending };
}

export type Actor = { id?: string; full_name?: string; email?: string } | null;

export type RoleChangeOutcome =
  | {
      ok: true;
      status: 200;
      participant: any;
      audit_state: AccessAuditState;
      evidence_id: string;
      role_change_blocked: boolean;
      occurrence: string;
      unchanged: boolean;
    }
  | {
      ok: false;
      status: number;
      error: string;
      applied: boolean;
      audit_state?: AccessAuditState;
      conflict?: string;
      evidence_id?: string;
      pending_occurrence?: string;
      role_change_blocked?: boolean;
      participant?: any;
      recovery?: Record<string, any>;
    };

export interface ApplyRoleInput {
  eventId: string;
  participantId: string;
  newRole: string;
  /** Campos adicionais gravados NA MESMA escrita do papel. */
  data?: Record<string, any>;
  actor: Actor;
  source: string;
  extraDetails?: Record<string, any>;
}

/**
 * ALTERAÇÃO de papel de um participante existente. Devolve o desfecho
 * estruturado; o chamador traduz para o status HTTP do seu endpoint.
 */
export async function applyParticipantRole(
  svc: any,
  input: ApplyRoleInput,
): Promise<RoleChangeOutcome> {
  const { eventId, participantId, newRole, data = {}, actor, source, extraDetails = {} } = input;
  if (!eventId || !participantId || !newRole) {
    return { ok: false, status: 400, error: "Alteração de papel sem evento, participante ou papel.", applied: false };
  }

  let rows: any[] = [];
  try {
    rows = await svc.entities.Participant.filter({ id: participantId, event_id: eventId });
  } catch (err: any) {
    return {
      ok: false, status: 503, applied: false, audit_state: "unavailable",
      error: "Não foi possível ler o participante (leitura indisponível). Nada foi alterado; tente novamente.",
    };
  }
  let current = rows?.[0] || null;
  if (!current) {
    return { ok: false, status: 404, error: "Participante não encontrado neste evento.", applied: false };
  }

  // 1. GATE — antes de qualquer escrita.
  const gate = await roleChangeGate(svc, current, eventId);
  if (gate.state === "unavailable") {
    return {
      ok: false, status: 503, applied: false, audit_state: "unavailable", role_change_blocked: true,
      error: "Não foi possível verificar a trilha da alteração de papel anterior (leitura indisponível). Nada foi alterado; tente novamente.",
    };
  }
  if (gate.state === "blocked") {
    return {
      ok: false, status: 409, applied: false, audit_state: "pending", role_change_blocked: true,
      pending_occurrence: gate.pending,
      error: "Este participante tem uma alteração de papel aplicada sem trilha de auditoria confirmada. Conclua a auditoria antes de alterar o papel novamente.",
      recovery: { op: "recoverRoleAudit", participant_id: participantId, event_id: eventId },
    };
  }
  if (gate.released) {
    // O papel pode ter mudado durante a liberação: old_value vem do estado real.
    try {
      const refreshed = await svc.entities.Participant.filter({ id: participantId, event_id: eventId });
      current = refreshed?.[0] || current;
    } catch { /* mantém o estado lido; a confirmação por leitura abaixo decide */ }
  }

  const oldRole = String(current.role_in_event || "");
  const targetRole = String(newRole);

  // Papel igual: aplica apenas os demais campos, sem evidência nem claim.
  if (oldRole === targetRole) {
    try {
      const updated = Object.keys(data).length > 0
        ? await svc.entities.Participant.update(participantId, data)
        : current;
      return {
        ok: true, status: 200, participant: updated, audit_state: "recorded",
        evidence_id: "", role_change_blocked: false, occurrence: "", unchanged: true,
      };
    } catch (err: any) {
      return { ok: false, status: 503, applied: false, error: `Não foi possível salvar os dados: ${msg(err)}` };
    }
  }

  // 2. EVIDÊNCIA DURÁVEL antes da mutação (fail-closed).
  const occurrence = newOccurrence(`participant:${participantId}`);
  let evidence: any = null;
  try {
    evidence = await createEvidence(svc, {
      event_id: eventId,
      entity_type: "Participant",
      entity_id: participantId,
      operation: "role_change",
      occurrence,
      old_value: oldRole,
      new_value: targetRole,
      actor_user_id: actor?.id || "system",
      actor_name: actor?.full_name || actor?.email || "",
      audit_key: buildAuditKey("role_change", occurrence),
      state: "started",
    });
  } catch (err: any) {
    console.error("[roleChange] evidência não gravada:", msg(err));
    return {
      ok: false, status: 503, applied: false, audit_state: "unavailable",
      error: "Não foi possível registrar a evidência da alteração de papel. Nada foi alterado; tente novamente.",
    };
  }

  // 3. CLAIM + MUTAÇÃO na MESMA escrita condicional.
  try {
    await svc.entities.Participant.updateMany(
      { id: participantId, event_id: eventId, [ROLE_LOCK_FIELD]: { $ne: true } },
      {
        $set: {
          ...data,
          role_in_event: targetRole,
          [ROLE_TOKEN_FIELD]: occurrence,
          [ROLE_LOCK_FIELD]: true,
          [ROLE_PENDING_FIELD]: occurrence,
        },
      },
    );
  } catch (err: any) {
    // Erro não prova ausência de escrita: a confirmação por leitura decide.
    console.error("[roleChange] claim de papel retornou erro:", msg(err));
  }

  // 4. PROVA por LEITURA (a resposta do updateMany não é autoridade).
  let persisted: any = null;
  try {
    const persistedRows = await svc.entities.Participant.filter({ id: participantId, event_id: eventId });
    persisted = persistedRows?.[0] || null;
  } catch (err: any) {
    console.error("[roleChange] leitura de confirmação do papel falhou:", msg(err));
  }

  const applied = !!persisted
    && String(persisted[ROLE_TOKEN_FIELD] || "") === occurrence
    && String(persisted[ROLE_PENDING_FIELD] || "") === occurrence
    && String(persisted.role_in_event || "") === targetRole;

  if (!applied) {
    const foreignPending = String(persisted?.[ROLE_PENDING_FIELD] || "");
    const lostClaim = !!persisted && !!foreignPending && foreignPending !== occurrence;
    if (lostClaim) {
      await markEvidence(svc, evidence?.id, {
        state: "not_applied",
        failure_reason: "claim ocupado por outra alteração",
      });
      return {
        ok: false, status: 409, applied: false, conflict: "role_change_concurrent",
        pending_occurrence: foreignPending, evidence_id: evidence?.id || "",
        error: "Outra alteração de papel deste participante foi aplicada primeiro. Nada foi alterado neste pedido; recarregue e tente novamente.",
      };
    }
    console.error("[roleChange] mutação de papel não comprovada por leitura:", occurrence);
    return {
      ok: false, status: 503, applied: false, audit_state: "unavailable",
      evidence_id: evidence?.id || "",
      error: "Não foi possível confirmar a alteração de papel no estado persistido. A evidência foi preservada e a operação pode ser conciliada.",
      recovery: {
        op: "recoverRoleAudit",
        participant_id: participantId,
        event_id: eventId,
        evidence_id: evidence?.id || "",
      },
    };
  }

  // 5. TRILHA OBRIGATÓRIA.
  await markEvidence(svc, evidence?.id, { state: "applied" });
  const auditState = await auditRoleChange(svc, actor, eventId, {
    entityId: participantId,
    occurrence,
    details: {
      field: "role_in_event",
      old_value: oldRole,
      new_value: targetRole,
      source,
      evidence_id: evidence?.id || "",
      ...extraDetails,
    },
  });
  await markEvidence(svc, evidence?.id, { state: evidenceStateFor(auditState), audit_state: auditState });

  // 6. LIBERAÇÃO só com trilha CONFIRMADA por leitura.
  const lockReleased = auditState === "recorded"
    ? await releaseRoleLock(svc, participantId, eventId, occurrence)
    : false;

  if (auditState === "unavailable") {
    return {
      ok: false, status: 503, applied: true, audit_state: "unavailable",
      participant: persisted, evidence_id: evidence?.id || "", role_change_blocked: true,
      error: "Papel alterado, mas a trilha de auditoria não pôde ser registrada. A evidência foi preservada: repita a recuperação para concluir a auditoria.",
      recovery: {
        op: "recoverRoleAudit",
        participant_id: participantId,
        event_id: eventId,
        evidence_id: evidence?.id || "",
      },
    };
  }

  return {
    ok: true,
    status: 200,
    participant: persisted,
    audit_state: auditState,
    evidence_id: evidence?.id || "",
    role_change_blocked: !lockReleased,
    occurrence,
    unchanged: false,
  };
}

export interface CreateRoleParticipantInput {
  eventId: string;
  /** Campos do participante; `role_in_event` define o papel concedido. */
  data: Record<string, any>;
  actor: Actor;
  source: string;
  extraDetails?: Record<string, any>;
}

/**
 * CRIAÇÃO de participante com papel. Papel privilegiado (qualquer coisa diferente
 * do default 'attendee') nasce com a MESMA proteção de uma alteração:
 *   • evidência gravada ANTES da criação (sem entity_id ainda, com a ocorrência);
 *   • a própria criação grava token + claim + pendência;
 *   • a evidência é então vinculada ao registro criado e a trilha é gravada;
 *   • o claim só é liberado com trilha confirmada.
 * Se a evidência não puder ser gravada, o participante NÃO é criado.
 */
export async function createParticipantWithRole(
  svc: any,
  input: CreateRoleParticipantInput,
): Promise<{ participant: any; audit_state: AccessAuditState | "not_required"; evidence_id: string; role_change_blocked: boolean; occurrence: string }> {
  const { eventId, data, actor, source, extraDetails = {} } = input;
  const role = String(data?.role_in_event || "attendee");

  if (role === "attendee") {
    const created = await svc.entities.Participant.create({ ...data, event_id: eventId });
    return { participant: created, audit_state: "not_required", evidence_id: "", role_change_blocked: false, occurrence: "" };
  }

  const occurrence = newOccurrence(`participant:new:${eventId}`);
  let evidence: any = null;
  try {
    evidence = await createEvidence(svc, {
      event_id: eventId,
      entity_type: "Participant",
      entity_id: "",
      operation: "role_change",
      occurrence,
      old_value: null,
      new_value: role,
      actor_user_id: actor?.id || "system",
      actor_name: actor?.full_name || actor?.email || "",
      audit_key: buildAuditKey("role_change", occurrence),
      state: "started",
    });
  } catch (err: any) {
    console.error("[roleChange] evidência da criação privilegiada não gravada:", msg(err));
    throw new Error("role_evidence_unavailable");
  }

  let created: any = null;
  try {
    created = await svc.entities.Participant.create({
      ...data,
      event_id: eventId,
      [ROLE_TOKEN_FIELD]: occurrence,
      [ROLE_LOCK_FIELD]: true,
      [ROLE_PENDING_FIELD]: occurrence,
    });
  } catch (err: any) {
    await markEvidence(svc, evidence?.id, {
      state: "not_applied",
      failure_reason: `criação falhou: ${msg(err)}`,
    });
    throw err;
  }
  if (!created?.id) {
    await markEvidence(svc, evidence?.id, { state: "not_applied", failure_reason: "criação não confirmada" });
    throw new Error("participant_create_unconfirmed");
  }

  await markEvidence(svc, evidence.id, { entity_id: created.id, state: "applied" });
  const auditState = await auditRoleChange(svc, actor, eventId, {
    entityId: created.id,
    occurrence,
    details: {
      field: "role_in_event",
      old_value: null,
      new_value: role,
      source,
      creation: true,
      evidence_id: evidence.id,
      ...extraDetails,
    },
  });
  await markEvidence(svc, evidence.id, { state: evidenceStateFor(auditState), audit_state: auditState });
  const lockReleased = auditState === "recorded"
    ? await releaseRoleLock(svc, created.id, eventId, occurrence)
    : false;

  return {
    participant: created,
    audit_state: auditState,
    evidence_id: evidence.id,
    role_change_blocked: !lockReleased,
    occurrence,
  };
}