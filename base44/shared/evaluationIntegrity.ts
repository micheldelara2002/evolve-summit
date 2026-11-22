// P2-06 (2026-11-22, residual) — EXCLUSÃO MÚTUA DURÁVEL DA AVALIAÇÃO.
//
// DEFEITO ORIGINAL: `filter → create` não garante unicidade — dois requests
// simultâneos leem "não existe" e ambos criam, duplicando o score.
//
// PRIMEIRA CORREÇÃO (insuficiente, apontada na revisão): convergência posterior
// por sobrevivente determinístico. O problema é a janela do post-read: dois
// requests podem concluir "sou o sobrevivente" ANTES de enxergar o registro do
// outro, e ambos devolvem sucesso; se o post-read falhar, o fluxo devolvia
// sucesso sem qualquer confirmação de integridade.
//
// CORREÇÃO ATUAL — CLAIM DURÁVEL POR (submissão, avaliador):
//
//   1. AQUISIÇÃO usa CAS no documento da PRÓPRIA submissão, que sempre existe:
//        AwardSubmission.updateMany(
//          { id, evaluation_claims: { $ne: reviewerId } },
//          { $addToSet: { evaluation_claims: reviewerId } })
//      A escrita é atômica no documento ⇒ em concorrência EXATAMENTE UM vence.
//      Quem perde recebe `claim_busy` (retryável) em vez de criar outra nota.
//      Avaliadores DIFERENTES do mesmo case não se bloqueiam (a chave do array
//      é o ID do avaliador, não a submissão).
//   2. LEASE em `EvaluationClaim` (um registro por par) guarda token + validade:
//      é o fencing token gravado em AwardEvaluation.claim_token e o que permite
//      RETOMAR um claim abandonado por crash — por CAS no token anterior, sem
//      sleep, sem lock permanente e sem depender de processo vivo.
//   3. LIBERAÇÃO é $pull idempotente, GUARDADA PELO TOKEN: uma execução que
//      perdeu o claim para uma retomada não consegue liberar o claim do novo
//      proprietário.
//   4. CONFIRMAÇÃO: a gravação só devolve sucesso depois de RELER e ver o
//      registro gravado. Falha de confirmação devolve `confirm_unavailable`
//      (nunca sucesso otimista).
//   5. REDE DE SEGURANÇA: todo cálculo de score continua deduplicando por
//      (submission_id, reviewer_user_id) — duplicatas legadas ou de versões
//      anteriores nunca contam duas vezes.
//
// LIMITAÇÃO DECLARADA (sem transação entre documentos): a nota vive em
// AwardEvaluation e o claim em AwardSubmission/EvaluationClaim. Existe uma
// janela teórica em que o proprietário verifica o token e, no instante seguinte,
// outro processo retoma o claim (só possível se o lease JÁ estivesse vencido) e
// grava antes. Mitigações: o lease é de 60 s; a retomada exige vencimento; o
// token é gravado na nota; e a deduplicação por par garante que, mesmo assim,
// apenas UMA avaliação é contabilizada. Não há garantia de atomicidade — há
// exclusão mútua real na aquisição, fencing por token e convergência no score.

import { deterministicCompare } from "./deterministicSurvivor.ts";

export const EVALUATION_CLAIM_TTL_MS = 60 * 1000;

export type EvaluationSaveResult =
  | { ok: true; evaluation: any; created: boolean; duplicatesRemoved: number; claimToken: string }
  | { ok: false; reason: string; error: string };

export type ClaimAcquisition =
  | { ok: true; token: string; leaseId: string; attempts: number }
  | { ok: false; reason: string; error: string };

function newToken(): string {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function scopeKey(submissionId: any, reviewerUserId: any): string {
  return `${String(submissionId || "")}|${String(reviewerUserId || "")}`;
}

/** Agrupa por (submissão, avaliador) mantendo a ordem determinística. */
export function groupEvaluationsByReviewer(rows: any[]): Map<string, any[]> {
  const groups = new Map<string, any[]>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.id) continue;
    const key = scopeKey(row.submission_id, row.reviewer_user_id);
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  for (const list of groups.values()) list.sort(deterministicCompare);
  return groups;
}

/**
 * Uma avaliação por (submissão, avaliador) — a sobrevivente determinística.
 * Usada por TODO cálculo de score/ranking.
 */
export function dedupeEvaluationsForScoring(rows: any[]): any[] {
  const out: any[] = [];
  for (const list of groupEvaluationsByReviewer(rows).values()) out.push(list[0]);
  return out;
}

async function readMine(svc: any, submissionId: string, reviewerUserId: string): Promise<any[]> {
  const rows = await svc.entities.AwardEvaluation.filter({
    submission_id: submissionId,
    reviewer_user_id: reviewerUserId,
    is_deleted: false,
  });
  if (!Array.isArray(rows)) throw new Error("leitura_invalida");
  return [...rows].sort(deterministicCompare);
}

async function readLease(svc: any, submissionId: string, reviewerUserId: string): Promise<any | null> {
  const rows = await svc.entities.EvaluationClaim.filter({
    submission_id: submissionId,
    reviewer_user_id: reviewerUserId,
    is_deleted: false,
  });
  if (!Array.isArray(rows)) throw new Error("leitura_invalida");
  if (rows.length === 0) return null;
  return [...rows].sort(deterministicCompare)[0];
}

async function removeDuplicates(svc: any, rows: any[]): Promise<number> {
  let removed = 0;
  for (const row of rows) {
    try {
      await svc.entities.AwardEvaluation.update(row.id, { is_deleted: true });
      removed++;
    } catch (err: any) {
      console.error("[evaluationIntegrity] remoção de duplicata falhou:", row?.id, err?.message || err);
    }
  }
  return removed;
}

/**
 * ADQUIRE o claim de (submissão, avaliador).
 * Ordem deliberada: LEASE primeiro, CAS no array depois — se o processo cair
 * entre os dois, o array não contém o avaliador e a próxima tentativa adquire
 * normalmente (nenhum lock órfão). Se o array já contém o avaliador, o lease diz
 * se o proprietário está vivo (não vencido → `claim_busy`) ou abandonado
 * (vencido → retomada por CAS no token anterior).
 */
export async function acquireEvaluationClaim(
  svc: any,
  params: {
    submissionId: string;
    reviewerUserId: string;
    eventId?: string;
    awardId?: string;
    ttlMs?: number;
    nowMs?: number;
  },
): Promise<ClaimAcquisition> {
  const submissionId = String(params?.submissionId || "");
  const reviewerUserId = String(params?.reviewerUserId || "");
  if (!submissionId || !reviewerUserId) {
    return { ok: false, reason: "identidade_ausente", error: "Avaliação sem submissão ou avaliador." };
  }
  const nowMs = Number.isFinite(params?.nowMs) ? Number(params.nowMs) : Date.now();
  const ttl = Number(params?.ttlMs) > 0 ? Number(params.ttlMs) : EVALUATION_CLAIM_TTL_MS;
  const token = newToken();
  const expiresAt = new Date(nowMs + ttl).toISOString();

  let lease: any = null;
  try {
    lease = await readLease(svc, submissionId, reviewerUserId);
  } catch (err: any) {
    console.error("[evaluationIntegrity] leitura do claim falhou:", err?.message || err);
    return { ok: false, reason: "claim_read_unavailable", error: "Não foi possível verificar a avaliação em andamento agora." };
  }

  // (1) PROPRIETÁRIO VIVO → busy, SEM tocar no lease dele.
  // (Ordem importa: renovar o lease antes de saber se o slot é nosso destruiria
  // o token/validade do proprietário atual e abriria duas escritas simultâneas.)
  const leaseHeld = lease && lease.state === "held";
  const holderExpiresMs = lease?.expires_at ? new Date(lease.expires_at).getTime() : 0;
  if (leaseHeld && holderExpiresMs > nowMs) {
    return { ok: false, reason: "claim_busy", error: "A avaliação deste case está sendo gravada agora. Tente novamente em instantes." };
  }

  // (2) CAS NO ARRAY — exclusão mútua atômica no documento da submissão.
  let claimed = 0;
  try {
    const res = await svc.entities.AwardSubmission.updateMany(
      { id: submissionId, evaluation_claims: { $ne: reviewerUserId } },
      { $addToSet: { evaluation_claims: reviewerUserId } },
    );
    claimed = res && res.updated ? res.updated : 0;
  } catch (err: any) {
    console.error("[evaluationIntegrity] aquisição do claim falhou:", err?.message || err);
    return { ok: false, reason: "claim_write_unavailable", error: "Não foi possível reservar a gravação da avaliação agora." };
  }

  if (claimed) {
    // Slot é nosso: agora registra/renova o lease com o token desta execução.
    let leaseId = "";
    const attempts = (Number(lease?.attempts) || 0) + 1;
    if (!lease) {
      let created: any = null;
      try {
        created = await svc.entities.EvaluationClaim.create({
          event_id: String(params?.eventId || ""),
          award_id: String(params?.awardId || ""),
          submission_id: submissionId,
          reviewer_user_id: reviewerUserId,
          state: "held",
          token,
          expires_at: expiresAt,
          attempts: 1,
          acquired_at: new Date(nowMs).toISOString(),
          is_deleted: false,
        });
      } catch (err: any) {
        console.error("[evaluationIntegrity] criação do claim falhou:", err?.message || err);
      }
      if (!created?.id) {
        // Sem lease não há como recuperar um claim abandonado: devolve o slot.
        await pullSlot(svc, submissionId, reviewerUserId);
        return { ok: false, reason: "claim_unavailable", error: "Não foi possível registrar o claim da avaliação agora." };
      }
      leaseId = created.id;
    } else {
      try {
        await svc.entities.EvaluationClaim.update(lease.id, {
          state: "held",
          token,
          expires_at: expiresAt,
          attempts,
          acquired_at: new Date(nowMs).toISOString(),
          released_at: null,
          release_reason: "",
          event_id: String(params?.eventId || lease.event_id || ""),
          award_id: String(params?.awardId || lease.award_id || ""),
        });
      } catch (err: any) {
        console.error("[evaluationIntegrity] renovação do claim falhou:", err?.message || err);
        await pullSlot(svc, submissionId, reviewerUserId);
        return { ok: false, reason: "claim_unavailable", error: "Não foi possível registrar o claim da avaliação agora." };
      }
      leaseId = lease.id;
    }
    return { ok: true, token, leaseId, attempts };
  }

  // (3) Slot ocupado. Só há retomada se houver lease VENCIDO (ou já liberado).
  if (!lease) {
    // Slot ocupado sem lease (registro legado/removido): não se retoma às cegas.
    return { ok: false, reason: "claim_busy", error: "A avaliação deste case está sendo gravada agora. Tente novamente em instantes." };
  }
  if (leaseHeld && holderExpiresMs > nowMs) {
    return { ok: false, reason: "claim_busy", error: "A avaliação deste case está sendo gravada agora. Tente novamente em instantes." };
  }

  // RETOMADA: CAS no token/estado ANTERIORES — exatamente um reclaimer vence.
  const takeoverToken = newToken();
  let takenOver = 0;
  try {
    const res = await svc.entities.EvaluationClaim.updateMany(
      { id: lease.id, token: lease.token, state: lease.state },
      {
        $set: {
          token: takeoverToken,
          state: "held",
          expires_at: new Date(nowMs + ttl).toISOString(),
          attempts: (Number(lease.attempts) || 0) + 1,
          acquired_at: new Date(nowMs).toISOString(),
          released_at: null,
          release_reason: "claim_expired",
        },
      },
    );
    takenOver = res && res.updated ? res.updated : 0;
  } catch (err: any) {
    console.error("[evaluationIntegrity] retomada do claim falhou:", err?.message || err);
  }
  if (takenOver) {
    return { ok: true, token: takeoverToken, leaseId: lease.id, attempts: (Number(lease.attempts) || 0) + 1 };
  }
  return { ok: false, reason: "claim_busy", error: "A avaliação deste case está sendo gravada agora. Tente novamente em instantes." };
}

async function pullSlot(svc: any, submissionId: string, reviewerUserId: string): Promise<void> {
  try {
    await svc.entities.AwardSubmission.updateMany(
      { id: submissionId, evaluation_claims: reviewerUserId },
      { $pull: { evaluation_claims: reviewerUserId } },
    );
  } catch (err: any) {
    console.error("[evaluationIntegrity] devolução do slot falhou:", err?.message || err);
  }
}

// Encerra o lease de uma tentativa que NÃO é proprietária. Guardado pelo token:
// nunca derruba o lease de quem detém o claim.
async function releaseLeaseOnly(svc: any, leaseId: string, token: string, reason: string): Promise<void> {
  if (!leaseId || !token) return;
  try {
    await svc.entities.EvaluationClaim.updateMany(
      { id: leaseId, token, state: "held" },
      { $set: { state: "released", released_at: new Date().toISOString(), release_reason: reason } },
    );
  } catch { /* o lease vence sozinho */ }
}

/**
 * LIBERA o claim (idempotente e GUARDADO PELO TOKEN).
 *
 * Só quem ainda é dono do lease consegue encerrá-lo; só depois disso o slot do
 * array é devolvido. Uma execução que perdeu o claim para uma retomada não
 * libera o claim do novo proprietário.
 */
export async function releaseEvaluationClaim(
  svc: any,
  params: { submissionId: string; reviewerUserId: string; leaseId: string; token: string; reason: string },
): Promise<boolean> {
  const submissionId = String(params?.submissionId || "");
  const reviewerUserId = String(params?.reviewerUserId || "");
  const leaseId = String(params?.leaseId || "");
  const token = String(params?.token || "");
  if (!submissionId || !reviewerUserId) return false;

  let owned = false;
  try {
    const res = await svc.entities.EvaluationClaim.updateMany(
      { id: leaseId, token, state: "held" },
      { $set: { state: "released", released_at: new Date().toISOString(), release_reason: String(params?.reason || "saved") } },
    );
    owned = !!(res && res.updated);
  } catch (err: any) {
    console.error("[evaluationIntegrity] liberação do lease falhou:", err?.message || err);
  }
  if (!owned) {
    // Token substituído (retomada por outro processo) ou lease já liberado:
    // NÃO se mexe no array — ele pertence a quem detém o token vigente.
    return false;
  }
  try {
    await svc.entities.AwardSubmission.updateMany(
      { id: submissionId, evaluation_claims: reviewerUserId },
      { $pull: { evaluation_claims: reviewerUserId } },
    );
  } catch (err: any) {
    // O slot fica até o lease vencer e ser retomado — nunca bloqueia para sempre.
    console.error("[evaluationIntegrity] devolução do slot falhou:", err?.message || err);
  }
  return true;
}

/**
 * Grava a avaliação do avaliador sob CLAIM, convergindo para UM registro.
 * Nunca lança: devolve estado explícito. Sucesso só com leitura de confirmação.
 */
export async function saveEvaluationOnce(
  svc: any,
  params: {
    submissionId: string;
    reviewerUserId: string;
    payload: Record<string, any>;
    eventId?: string;
    awardId?: string;
    nowMs?: number;
    ttlMs?: number;
  },
): Promise<EvaluationSaveResult> {
  const submissionId = String(params?.submissionId || "");
  const reviewerUserId = String(params?.reviewerUserId || "");
  const payload = params?.payload || {};
  if (!submissionId || !reviewerUserId) {
    return { ok: false, reason: "identidade_ausente", error: "Avaliação sem submissão ou avaliador." };
  }

  // (1) CLAIM — sem ele não se escreve: concorrência não gera duas notas.
  const claim = await acquireEvaluationClaim(svc, {
    submissionId,
    reviewerUserId,
    eventId: params?.eventId,
    awardId: params?.awardId,
    nowMs: params?.nowMs,
    ttlMs: params?.ttlMs,
  });
  if (!claim.ok) {
    return { ok: false, reason: claim.reason, error: claim.error };
  }

  const release = async (reason: string) => {
    await releaseEvaluationClaim(svc, {
      submissionId,
      reviewerUserId,
      leaseId: claim.leaseId,
      token: claim.token,
      reason,
    });
  };

  // (2) LEITURA do estado atual.
  let mine: any[] = [];
  try {
    mine = await readMine(svc, submissionId, reviewerUserId);
  } catch (err: any) {
    console.error("[evaluationIntegrity] leitura falhou:", err?.message || err);
    await release("read_unavailable");
    return { ok: false, reason: "read_unavailable", error: "Não foi possível ler as avaliações agora." };
  }

  const payloadWithToken = { ...payload, claim_token: claim.token };

  // (3) EXISTE: atualiza a sobrevivente determinística.
  if (mine.length > 0) {
    const survivor = mine[0];
    try {
      await svc.entities.AwardEvaluation.update(survivor.id, payloadWithToken);
    } catch (err: any) {
      console.error("[evaluationIntegrity] atualização falhou:", err?.message || err);
      await release("update_failed");
      return { ok: false, reason: "update_failed", error: "Não foi possível salvar a avaliação agora." };
    }
    const duplicatesRemoved = await removeDuplicates(svc, mine.slice(1));
    // (4) CONFIRMAÇÃO POR LEITURA — sucesso otimista não existe.
    let confirmed: any[] = [];
    try {
      confirmed = await readMine(svc, submissionId, reviewerUserId);
    } catch (err: any) {
      await release("confirm_unavailable");
      return { ok: false, reason: "confirm_unavailable", error: "A avaliação foi enviada, mas não foi possível confirmar a gravação. Tente novamente." };
    }
    if (confirmed.length === 0) {
      await release("confirm_unavailable");
      return { ok: false, reason: "confirm_unavailable", error: "A avaliação não confirmou a gravação. Tente novamente." };
    }
    await release("saved");
    return { ok: true, evaluation: confirmed[0], created: false, duplicatesRemoved, claimToken: claim.token };
  }

  // (5) NÃO EXISTE: cria sob o claim e confirma.
  let created: any = null;
  try {
    created = await svc.entities.AwardEvaluation.create(payloadWithToken);
  } catch (err: any) {
    console.error("[evaluationIntegrity] criação falhou:", err?.message || err);
    await release("create_failed");
    return { ok: false, reason: "create_failed", error: "Não foi possível registrar a avaliação agora." };
  }
  if (!created?.id) {
    await release("create_unconfirmed");
    return { ok: false, reason: "create_unconfirmed", error: "A avaliação não confirmou a gravação." };
  }

  let after: any[] = [];
  try {
    after = await readMine(svc, submissionId, reviewerUserId);
  } catch (err: any) {
    // Sem confirmação NÃO se declara sucesso — o retry encontra o registro e
    // atualiza (idempotente).
    await release("confirm_unavailable");
    return { ok: false, reason: "confirm_unavailable", error: "A avaliação foi enviada, mas não foi possível confirmar a gravação. Tente novamente." };
  }
  if (after.length === 0) {
    await release("confirm_unavailable");
    return { ok: false, reason: "confirm_unavailable", error: "A avaliação não confirmou a gravação. Tente novamente." };
  }

  // Rede de segurança: duplicata legada que já existia tem precedência
  // determinística — esta criação é retirada e a nota vai para a sobrevivente.
  const survivor = after[0];
  if (survivor.id !== created.id) {
    let removed = 0;
    try {
      await svc.entities.AwardEvaluation.update(created.id, { is_deleted: true });
      removed = 1;
    } catch (err: any) {
      console.error("[evaluationIntegrity] retirada do duplicado falhou:", err?.message || err);
    }
    try {
      await svc.entities.AwardEvaluation.update(survivor.id, payloadWithToken);
    } catch (err: any) {
      await release("update_failed");
      return { ok: false, reason: "update_failed", error: "Não foi possível salvar a avaliação agora." };
    }
    const duplicatesRemoved = await removeDuplicates(svc, after.slice(1)) + removed;
    await release("saved");
    return { ok: true, evaluation: { ...survivor, ...payloadWithToken }, created: false, duplicatesRemoved, claimToken: claim.token };
  }

  const duplicatesRemoved = await removeDuplicates(svc, after.slice(1));
  await release("saved");
  return { ok: true, evaluation: created, created: true, duplicatesRemoved, claimToken: claim.token };
}