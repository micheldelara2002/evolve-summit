// P0-B (2026-11-04) — TRILHA OBRIGATÓRIA de operações financeiras.
//
// Contrato: sem trilha confirmada, a operação financeira não conclui (D1).
//   • writeMandatoryAudit  → grava e CONFIRMA. Erro/ausência de confirmação
//     lança AuditUnavailableError. Idempotente por audit_key (derivada da
//     operação, nunca do horário): webhook duplicado/retry/replay não duplica
//     registro.
//   • recordPendingTrail   → quando o efeito externo JÁ ocorreu e a trilha
//     falhou: registra o caso (status 'pending') com provedor, referência
//     externa, valor e motivo, para a reconciliação concluir depois. Nunca
//     lança — se nem isso gravar, o log técnico + retry do provedor cobrem.
//   • resolvePendingTrails → rotina de reconciliação: regrava a trilha
//     original e marca o caso como 'resolved'.
//
// A lista fechada de operações obrigatórias (MANDATORY_AUDIT_OPERATIONS) é a
// fonte única: novos fluxos financeiros usam uma destas operações como base da
// chave, nunca uma string solta.

import { deterministicCompare } from "./deterministicSurvivor.ts";

export class AuditUnavailableError extends Error {
  code = "audit_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "AuditUnavailableError";
  }
}

// Lista fechada e revisada (§5.1 / §11 item 4 do plano).
// Cabeadas na entrega P0-B-1: checkout_iniciado, pagamento_confirmado,
// pagamento_cancelado, pagamento_expirado, estorno_solicitado,
// estorno_confirmado. A EMISSÃO de ingressos é coberta por
// pagamento_confirmado (trilha obrigatória gravada imediatamente antes da
// emissão) + o registro auxiliar de emissão. Pendentes para P0-B-2:
// estorno_falhou, config_comercio_alterada, repasse_alterado.
export const MANDATORY_AUDIT_OPERATIONS = [
  "checkout_iniciado",
  "pagamento_confirmado",
  "pagamento_cancelado",
  "pagamento_expirado",
  "estorno_solicitado",
  "estorno_confirmado",
  "estorno_falhou",
  "config_comercio_alterada",
  "repasse_alterado",
] as const;

export type MandatoryAuditOperation = typeof MANDATORY_AUDIT_OPERATIONS[number];

// Chave determinística: '<operação>|<referência>[|<extra>]'.
export function buildAuditKey(
  operation: string,
  reference: string | number,
  extra?: string | number,
): string {
  return [operation, String(reference ?? ""), extra === undefined ? "" : String(extra)]
    .filter((p) => p !== "")
    .join("|");
}

// Hash determinístico (djb2) de um payload — base das chaves de operações que
// não têm identificador único próprio (ex.: alteração de configuração).
export function auditHash(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function findAuditByKey(svc: any, key: string): Promise<any | null> {
  const rows = await svc.entities.AuditLog.filter({ audit_key: key });
  if (!rows || rows.length === 0) return null;
  return [...rows].sort(deterministicCompare)[0];
}

// Grava e CONFIRMA a trilha obrigatória. Lança AuditUnavailableError quando
// não há confirmação — o chamador decide o bloqueio/compensação.
export async function writeMandatoryAudit(
  svc: any,
  entry: Record<string, any>,
): Promise<{ id: string; duplicate: boolean }> {
  const key = String(entry.audit_key || "");
  if (!key) throw new AuditUnavailableError("audit_key obrigatório na trilha mandatória.");

  let existing: any = null;
  try {
    existing = await findAuditByKey(svc, key);
  } catch (err: any) {
    throw new AuditUnavailableError(`Trilha indisponível: ${err?.message || err}`);
  }
  // Idempotência: a mesma operação já tem trilha — nada é duplicado.
  if (existing) return { id: existing.id, duplicate: true };

  let created: any = null;
  try {
    created = await svc.entities.AuditLog.create({
      status: "recorded",
      mandatory: true,
      ...entry,
    });
  } catch (err: any) {
    throw new AuditUnavailableError(`Falha ao gravar trilha: ${err?.message || err}`);
  }
  if (!created || !created.id) {
    throw new AuditUnavailableError("Trilha não confirmou a gravação.");
  }

  // Corrida entre dois escritores com a mesma chave: sobrevive o determinístico
  // (created_date + id); o excedente é descartado para não duplicar a trilha.
  try {
    const rows = await svc.entities.AuditLog.filter({ audit_key: key });
    const survivor = [...(rows || [])].sort(deterministicCompare)[0];
    if (survivor && survivor.id !== created.id) {
      try { await svc.entities.AuditLog.delete(created.id); } catch { /* já resolvido */ }
      return { id: survivor.id, duplicate: true };
    }
  } catch {
    // Confirmação da gravação já obtida no create — a checagem é reforço.
  }

  return { id: created.id, duplicate: false };
}

// Registra caso PENDENTE DE TRILHA (efeito externo já ocorreu). Devolve o id do
// registro ou null se nem o registro do caso foi possível (o retry do provedor
// e a varredura de reconciliação continuam cobrindo o desfecho).
export async function recordPendingTrail(
  svc: any,
  entry: Record<string, any>,
): Promise<string | null> {
  const key = String(entry.audit_key || "");
  const pendingKey = key ? `${key}|pending` : "";
  // Entrada original normalizada — é o que a reconciliação vai regravar
  // (campos obrigatórios garantidos, sem o motivo da falha misturado).
  const original = {
    action: entry.action || "status_change",
    entity_type: entry.entity_type || "Payment",
    entity_id: entry.entity_id || "",
    user_id: entry.user_id || "system",
    user_name: entry.user_name || "Automatico",
    event_id: entry.event_id || "",
    ip_address: entry.ip_address || "",
    audit_key: key,
    provider: entry.provider || "stripe",
    external_reference: entry.external_reference || "",
    amount: Number(entry.amount) || 0,
    details: entry.details || JSON.stringify({ type: "trilha_pendente" }),
  };
  const payload = {
    action: entry.action || "status_change",
    entity_type: entry.entity_type || "Payment",
    entity_id: entry.entity_id || "",
    user_id: entry.user_id || "system",
    user_name: entry.user_name || "Automático",
    event_id: entry.event_id || "",
    audit_key: pendingKey || undefined,
    mandatory: true,
    status: "pending",
    provider: entry.provider || "stripe",
    external_reference: entry.external_reference || "",
    amount: Number(entry.amount) || 0,
    failure_reason: String(entry.failure_reason || "Trilha indisponível."),
    details: JSON.stringify({ type: "trilha_pendente", entry: original }),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const created = await svc.entities.AuditLog.create(payload);
      if (created?.id) return created.id;
    } catch (err: any) {
      console.error(`[recordPendingTrail] tentativa ${attempt + 1} falhou:`, err?.message || err);
    }
  }
  console.error("[recordPendingTrail] caso pendente não pôde ser registrado:", pendingKey || key);
  return null;
}

// Reconciliação: regrava a trilha original dos casos pendentes e registra o
// desfecho. Idempotente — rodar de novo não duplica nem reescreve resolvidos.
export async function resolvePendingTrails(
  svc: any,
  limit = 50,
): Promise<{ resolved: number; failed: number; examined: number }> {
  const rows = await svc.entities.AuditLog.filter(
    { status: "pending", mandatory: true },
    "created_date",
    Math.max(1, Math.min(Number(limit) || 50, 200)),
  );
  const pending = Array.isArray(rows) ? rows : (rows?.items || []);
  let resolved = 0;
  let failed = 0;

  for (const row of pending) {
    let original: any = null;
    try {
      original = JSON.parse(row.details || "{}")?.entry || null;
    } catch {
      original = null;
    }
    if (!original || !original.audit_key) {
      try {
        await svc.entities.AuditLog.update(row.id, {
          status: "resolved",
          resolved_at: new Date().toISOString(),
          failure_reason: "Caso pendente sem entrada original — verificar manualmente.",
        });
      } catch { /* próxima execução tenta de novo */ }
      failed++;
      continue;
    }
    try {
      const written = await writeMandatoryAudit(svc, original);
      await svc.entities.AuditLog.update(row.id, {
        status: "resolved",
        resolved_at: new Date().toISOString(),
        failure_reason: `Trilha regravada (${written.id}${written.duplicate ? ", já existente" : ""}).`,
      });
      resolved++;
    } catch (err: any) {
      console.error("[resolvePendingTrails] ainda indisponível:", err?.message || err);
      failed++;
    }
  }

  return { resolved, failed, examined: pending.length };
}