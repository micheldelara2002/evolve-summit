// P2-06 (2026-11-22) — UNICIDADE DA AVALIAÇÃO (AwardEvaluation).
//
// DEFEITO CORRIGIDO: `manageAward.saveEvaluation` fazia
// `filter({ submission_id, reviewer_user_id })` e, quando não encontrava nada,
// `create(...)`. Esse padrão consulta-depois-cria NÃO garante unicidade: duas
// requisições simultâneas (duplo clique, retry do cliente, duas abas) leem
// "não existe" ao mesmo tempo e ambas criam. O resultado é avaliação duplicada,
// score duplicado no ranking e média distorcida.
//
// A plataforma NÃO oferece índice único nem transação entre documentos, e o id
// de um registro é gerado pelo servidor da plataforma (não é possível impor um
// id determinístico). A garantia possível — e a que o restante do app já usa
// para o mesmo problema — é CONVERGÊNCIA POR SOBREVIVENTE DETERMINÍSTICO:
//
//   1. Lê as avaliações do avaliador naquela submissão.
//   2. Se existe: atualiza a SOBREVIVENTE (created_date + id) e remove as
//      duplicatas (soft delete) — retry é idempotente.
//   3. Se não existe: cria, RE-LÊ e elege a sobrevivente. Quem criou e não é a
//      sobrevivente remove o próprio registro e devolve a sobrevivente.
//      ⇒ em qualquer corrida, ao final existe EXATAMENTE UMA avaliação lógica.
//   4. O cálculo de score/ranking deduplica por (submission_id, reviewer_user_id)
//      ANTES de agregar — mesmo que uma duplicata transitória exista durante a
//      corrida, ela NUNCA conta duas vezes.
//
// Não há "claim" com validade porque não existe primitiva de lock por
// (submissão, avaliador) sem índice único: um claim em campo compartilhado
// serializaria avaliadores diferentes da mesma submissão e poderia ficar preso
// após crash. A convergência por sobrevivente não tem estado intermediário e se
// recupera sozinha em toda releitura.

import { deterministicCompare } from "./deterministicSurvivor.ts";

export type EvaluationSaveResult =
  | { ok: true; evaluation: any; created: boolean; duplicatesRemoved: number }
  | { ok: false; reason: string; error: string };

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
 * Grava a avaliação do avaliador para a submissão, convergindo para UM registro.
 * Nunca lança: devolve estado explícito.
 */
export async function saveEvaluationOnce(
  svc: any,
  params: {
    submissionId: string;
    reviewerUserId: string;
    payload: Record<string, any>;
  },
): Promise<EvaluationSaveResult> {
  const submissionId = String(params?.submissionId || "");
  const reviewerUserId = String(params?.reviewerUserId || "");
  const payload = params?.payload || {};
  if (!submissionId || !reviewerUserId) {
    return { ok: false, reason: "identidade_ausente", error: "Avaliação sem submissão ou avaliador." };
  }

  let mine: any[] = [];
  try {
    mine = await readMine(svc, submissionId, reviewerUserId);
  } catch (err: any) {
    console.error("[evaluationIntegrity] leitura falhou:", err?.message || err);
    return { ok: false, reason: "read_unavailable", error: "Não foi possível ler as avaliações agora." };
  }

  if (mine.length > 0) {
    const survivor = mine[0];
    try {
      await svc.entities.AwardEvaluation.update(survivor.id, payload);
    } catch (err: any) {
      console.error("[evaluationIntegrity] atualização falhou:", err?.message || err);
      return { ok: false, reason: "update_failed", error: "Não foi possível salvar a avaliação agora." };
    }
    const duplicatesRemoved = await removeDuplicates(svc, mine.slice(1));
    return {
      ok: true,
      evaluation: { ...survivor, ...payload },
      created: false,
      duplicatesRemoved,
    };
  }

  let created: any = null;
  try {
    created = await svc.entities.AwardEvaluation.create(payload);
  } catch (err: any) {
    console.error("[evaluationIntegrity] criação falhou:", err?.message || err);
    return { ok: false, reason: "create_failed", error: "Não foi possível registrar a avaliação agora." };
  }
  if (!created?.id) {
    return { ok: false, reason: "create_unconfirmed", error: "A avaliação não confirmou a gravação." };
  }

  // Convergência: se outra requisição criou ao mesmo tempo, sobrevive a mais
  // antiga (created_date + id) e esta se retira.
  let after: any[] = [];
  try {
    after = await readMine(svc, submissionId, reviewerUserId);
  } catch {
    // Sem confirmação de leitura, não há duplicata conhecida: devolve o criado.
    return { ok: true, evaluation: created, created: true, duplicatesRemoved: 0 };
  }

  const survivor = after[0];
  if (survivor && survivor.id !== created.id) {
    let removed = 0;
    try {
      await svc.entities.AwardEvaluation.update(created.id, { is_deleted: true });
      removed = 1;
    } catch (err: any) {
      console.error("[evaluationIntegrity] retirada do duplicado falhou:", err?.message || err);
    }
    return { ok: true, evaluation: survivor, created: false, duplicatesRemoved: removed };
  }

  const duplicatesRemoved = await removeDuplicates(svc, after.slice(1));
  return { ok: true, evaluation: created, created: true, duplicatesRemoved };
}