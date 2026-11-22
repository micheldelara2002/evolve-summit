// P2-06 (2026-11-22) — UMA AVALIAÇÃO LÓGICA POR (SUBMISSÃO, AVALIADOR).
//
// Defeito original: `filter` → `create`. Duas requisições simultâneas (duplo
// clique, retry do cliente, duas abas) liam "não existe" ao mesmo tempo e
// criavam DUAS avaliações — score duplicado, média e ranking distorcidos.
//
// Aqui se prova: a gravação converge para a sobrevivente determinística, o
// cálculo de score deduplica, e o caminho HTTP (manageAward.saveEvaluation)
// mantém a autorização e a validação de notas.

import test from "node:test";
import assert from "node:assert/strict";

import {
  groupEvaluationsByReviewer,
  dedupeEvaluationsForScoring,
  saveEvaluationOnce,
} from "../../base44/shared/evaluationIntegrity.ts";
import { createFakeDb } from "./lib/fakeDb.mjs";
import { makeHttpClient, invoke } from "./lib/fakeHttpClient.mjs";
import manageAward from "../../base44/functions/manageAward/entry.ts";

const evaluation = (over = {}) => ({
  id: "ae_1",
  submission_id: "sub_1",
  reviewer_user_id: "u_rev",
  total_score: 10,
  is_deleted: false,
  created_date: "2026-01-01T00:00:00.000Z",
  ...over,
});

const CRITERIA = [
  { id: "c1", label: "Impacto", max_score: 10, weight: 2 },
  { id: "c2", label: "Clareza", max_score: 5, weight: 1 },
];

function awardClient(user, over = {}) {
  return makeHttpClient({
    user,
    collections: {
      User: [user],
      AwardConfig: [{
        id: "aw_1",
        event_id: "evt_1",
        is_deleted: false,
        is_active: true,
        assigned_reviewer_ids: JSON.stringify(["u_rev"]),
        criteria_config: JSON.stringify(CRITERIA),
        ...(over.config || {}),
      }],
      AwardSubmission: [{
        id: "sub_1",
        award_id: "aw_1",
        event_id: "evt_1",
        status: "pending",
        is_deleted: false,
        ...(over.submission || {}),
      }],
      EventMembership: [{
        event_id: "evt_1",
        user_id: "u_rev",
        role: "reviewer",
        is_active: true,
        is_deleted: false,
      }],
      AwardEvaluation: [],
      AuditLog: [],
    },
  });
}

const REVIEWER = { id: "u_rev", role: "user", email: "rev@example.com", full_name: "Revisora" };

// ===== Agrupamento e deduplicação =====

test("agrupa por (submissão, avaliador) e elege o sobrevivente determinístico", () => {
  const rows = [
    evaluation({ id: "ae_b", created_date: "2026-01-02T00:00:00.000Z" }),
    evaluation({ id: "ae_a", created_date: "2026-01-01T00:00:00.000Z" }),
    evaluation({ id: "ae_other", reviewer_user_id: "u_2" }),
  ];
  const groups = groupEvaluationsByReviewer(rows);
  assert.equal(groups.size, 2);
  assert.equal(groups.get("sub_1|u_rev")[0].id, "ae_a", "o mais antigo sobrevive");
  assert.equal(dedupeEvaluationsForScoring(rows).length, 2, "uma por par");
});

test("a deduplicação é estável independentemente da ordem de entrada", () => {
  const a = evaluation({ id: "ae_a", created_date: "2026-01-01T00:00:00.000Z" });
  const b = evaluation({ id: "ae_b", created_date: "2026-01-02T00:00:00.000Z" });
  const forward = dedupeEvaluationsForScoring([a, b]).map((r) => r.id);
  const backward = dedupeEvaluationsForScoring([b, a]).map((r) => r.id);
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward, ["ae_a"]);
});

test("desempate por id quando o created_date é o mesmo", () => {
  const rows = [evaluation({ id: "ae_z" }), evaluation({ id: "ae_y" })];
  assert.deepEqual(dedupeEvaluationsForScoring(rows).map((r) => r.id), ["ae_y"]);
});

test("score com duplicatas NÃO soma duas vezes a mesma nota", () => {
  const rows = [
    evaluation({ id: "ae_a", total_score: 20 }),
    evaluation({ id: "ae_b", total_score: 20 }),
    evaluation({ id: "ae_c", reviewer_user_id: "u_2", total_score: 10 }),
  ];
  const total = dedupeEvaluationsForScoring(rows).reduce((sum, r) => sum + r.total_score, 0);
  assert.equal(total, 30, "20 (uma vez) + 10");
  assert.equal(rows.reduce((s, r) => s + r.total_score, 0), 50, "sem dedupe o score inflaria");
});

// ===== Gravação convergente =====

test("primeira avaliação é criada; a segunda ATUALIZA a mesma (nunca duplica)", async () => {
  const db = createFakeDb({ awardEvaluations: [] });
  const params = { submissionId: "sub_1", reviewerUserId: "u_rev" };
  // O payload é o registro gravado — ele carrega o escopo (submissão + avaliador),
  // como em manageAward.
  const scope = { submission_id: "sub_1", reviewer_user_id: "u_rev" };

  const first = await saveEvaluationOnce(db.svc, { ...params, payload: { ...scope, total_score: 20 } });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);

  const second = await saveEvaluationOnce(db.svc, { ...params, payload: { ...scope, total_score: 23 } });
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.evaluation.id, first.evaluation.id);
  assert.equal(db.awardEvaluations.length, 1, "retry não cria um segundo registro");
  assert.equal(db.awardEvaluations[0].total_score, 23);
});

test("duplicatas pré-existentes convergem: uma sobrevive e a excedente é encerrada", async () => {
  const db = createFakeDb({
    awardEvaluations: [
      evaluation({ id: "ae_b", created_date: "2026-01-02T00:00:00.000Z", total_score: 15 }),
      evaluation({ id: "ae_a", created_date: "2026-01-01T00:00:00.000Z", total_score: 15 }),
    ],
  });
  const out = await saveEvaluationOnce(db.svc, {
    submissionId: "sub_1", reviewerUserId: "u_rev", payload: { total_score: 22 },
  });
  assert.equal(out.ok, true);
  assert.equal(out.evaluation.id, "ae_a");
  assert.equal(out.duplicatesRemoved, 1);

  const active = db.awardEvaluations.filter((r) => r.is_deleted !== true);
  assert.equal(active.length, 1, "sobra exatamente uma avaliação lógica");
  assert.equal(active[0].total_score, 22);
});

test("leitura indisponível é recusa explícita (não cria às cegas)", async () => {
  const db = createFakeDb({ awardEvaluations: [] });
  const svc = {
    entities: {
      ...db.svc.entities,
      AwardEvaluation: { filter: async () => { throw new Error("leitura indisponível"); } },
    },
  };
  const out = await saveEvaluationOnce(svc, {
    submissionId: "sub_1", reviewerUserId: "u_rev", payload: { total_score: 10 },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "read_unavailable");
  assert.equal(db.awardEvaluations.length, 0);
});

test("falha de criação é recusa explícita", async () => {
  const db = createFakeDb({ awardEvaluations: [] });
  const svc = {
    entities: {
      ...db.svc.entities,
      AwardEvaluation: { ...db.svc.entities.AwardEvaluation, create: async () => { throw new Error("escrita indisponível"); } },
    },
  };
  const out = await saveEvaluationOnce(svc, {
    submissionId: "sub_1", reviewerUserId: "u_rev", payload: { total_score: 10 },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "create_failed");
});

// ===== Caminho HTTP: manageAward.saveEvaluation =====

test("avaliador da banca grava a nota com total ponderado", async () => {
  const client = awardClient(REVIEWER);
  const res = await invoke(manageAward, client.base44, {
    action: "saveEvaluation",
    submission_id: "sub_1",
    scores: { c1: 8, c2: 4 },
    notes: "bom case",
  });
  assert.equal(res.status, 200);
  const rows = client.rows.AwardEvaluation;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total_score, 20, "8×2 + 4×1");
  assert.deepEqual(JSON.parse(rows[0].scores), { c1: 8, c2: 4 });
  assert.equal(rows[0].reviewer_user_id, "u_rev");
  assert.equal(rows[0].status, "submitted");
  assert.equal(client.rows.AuditLog.length, 1, "a decisão fica na trilha");
});

test("reenvio do avaliador atualiza a MESMA avaliação", async () => {
  const client = awardClient(REVIEWER);
  await invoke(manageAward, client.base44, { action: "saveEvaluation", submission_id: "sub_1", scores: { c1: 8, c2: 4 } });
  const second = await invoke(manageAward, client.base44, { action: "saveEvaluation", submission_id: "sub_1", scores: { c1: 9, c2: 5 } });
  assert.equal(second.status, 200);
  assert.equal(client.rows.AwardEvaluation.length, 1);
  assert.equal(client.rows.AwardEvaluation[0].total_score, 23);
});

test("quem não é da banca recebe 403 e nada é gravado", async () => {
  const outsider = { id: "u_other", role: "user", email: "outro@example.com", full_name: "Outro" };
  const client = awardClient(outsider);
  client.rows.User.push(outsider);
  const res = await invoke(manageAward, client.base44, {
    action: "saveEvaluation", submission_id: "sub_1", scores: { c1: 5 },
  });
  assert.equal(res.status, 403);
  assert.equal(client.rows.AwardEvaluation.length, 0);
});

test("critério inexistente é recusado", async () => {
  const client = awardClient(REVIEWER);
  const res = await invoke(manageAward, client.base44, {
    action: "saveEvaluation", submission_id: "sub_1", scores: { c9: 5 },
  });
  assert.equal(res.status, 400);
  assert.equal(client.rows.AwardEvaluation.length, 0);
});

test("nota negativa, acima do máximo ou não numérica é recusada", async () => {
  const cases = [{ c1: -1 }, { c1: 11 }, { c1: "abc" }];
  for (const scores of cases) {
    const client = awardClient(REVIEWER);
    const res = await invoke(manageAward, client.base44, { action: "saveEvaluation", submission_id: "sub_1", scores });
    assert.equal(res.status, 400, `scores ${JSON.stringify(scores)} deveriam ser recusadas`);
    assert.equal(client.rows.AwardEvaluation.length, 0);
  }
});

test("premiação sem critérios não aceita avaliação", async () => {
  const client = awardClient(REVIEWER, { config: { criteria_config: "" } });
  const res = await invoke(manageAward, client.base44, {
    action: "saveEvaluation", submission_id: "sub_1", scores: { c1: 5 },
  });
  assert.equal(res.status, 409);
});

test("case de OUTRO evento não é avaliado por esta premiação", async () => {
  const client = awardClient(REVIEWER, { submission: { event_id: "evt_2" } });
  const res = await invoke(manageAward, client.base44, {
    action: "saveEvaluation", submission_id: "sub_1", scores: { c1: 5 },
  });
  assert.equal(res.status, 409);
  assert.equal(client.rows.AwardEvaluation.length, 0);
});