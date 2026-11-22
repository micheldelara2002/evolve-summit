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
  acquireEvaluationClaim,
  releaseEvaluationClaim,
  EVALUATION_CLAIM_TTL_MS,
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

// P2-06 (residual) — o claim vive na AwardSubmission (documento que sempre
// existe), então todo cenário precisa da submissão.
function evalDb(over = {}) {
  return createFakeDb({
    awardSubmissions: [
      { id: "sub_1", award_id: "aw_1", event_id: "evt_1", is_deleted: false, ...(over.submission || {}) },
    ],
    awardEvaluations: over.awardEvaluations || [],
    evaluationClaims: over.evaluationClaims || [],
  });
}

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
      AwardEvaluation: over.awardEvaluations || [],
      EvaluationClaim: over.evaluationClaims || [],
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
  const db = evalDb();
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
  const db = evalDb({
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
  const db = evalDb();
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
  const db = evalDb();
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

// ===== P2-06 (residual) — CLAIM DURÁVEL E CONCORRÊNCIA =====
//
// A convergência posterior não bastava: dois requests podiam concluir "sou o
// sobrevivente" antes de enxergar o registro do outro. Agora a exclusão mútua é
// um CAS no documento da submissão (`evaluation_claims`), com lease em
// EvaluationClaim para retomar claim abandonado — sem sleep e sem lock eterno.

const T0 = Date.parse("2026-11-22T12:00:00.000Z");

test("(1) claim adquirido por A: B recebe claim_busy (nada é gravado por B)", async () => {
  const db = evalDb();
  const a = await acquireEvaluationClaim(db.svc, { submissionId: "sub_1", reviewerUserId: "u_rev", nowMs: T0 });
  assert.equal(a.ok, true);
  const b = await acquireEvaluationClaim(db.svc, { submissionId: "sub_1", reviewerUserId: "u_rev", nowMs: T0 + 1000 });
  assert.equal(b.ok, false);
  assert.equal(b.reason, "claim_busy");
  assert.deepEqual(db.awardSubmissions[0].evaluation_claims, ["u_rev"], "o slot pertence a A");
});

test("(2) claim abandonado (lease vencido) é RETOMADO — e A não libera o claim de B", async () => {
  const db = evalDb();
  const a = await acquireEvaluationClaim(db.svc, { submissionId: "sub_1", reviewerUserId: "u_rev", nowMs: T0 });
  assert.equal(a.ok, true);

  const b = await acquireEvaluationClaim(db.svc, {
    submissionId: "sub_1",
    reviewerUserId: "u_rev",
    nowMs: T0 + EVALUATION_CLAIM_TTL_MS + 1000,
  });
  assert.equal(b.ok, true, "o claim vencido é retomável (sem lock permanente)");
  assert.notEqual(b.token, a.token);
  assert.equal(b.leaseId, a.leaseId, "o lease é o mesmo registro, com token novo");
  assert.equal(db.evaluationClaims[0].attempts, 2);

  // FENCING: a execução antiga não consegue liberar o claim do novo dono.
  const released = await releaseEvaluationClaim(db.svc, {
    submissionId: "sub_1",
    reviewerUserId: "u_rev",
    leaseId: a.leaseId,
    token: a.token,
    reason: "saved",
  });
  assert.equal(released, false);
  assert.deepEqual(db.awardSubmissions[0].evaluation_claims, ["u_rev"], "o slot continua com B");
});

test("(3) interleaving controlado: dois requests disputam o claim — UMA única avaliação", async () => {
  const db = evalDb();
  const original = db.svc.entities.AwardSubmission.updateMany;
  let arrived = 0;
  let openFirstGate;
  const firstGate = new Promise((resolve) => { openFirstGate = resolve; });
  let signalSecond;
  const secondArrived = new Promise((resolve) => { signalSecond = resolve; });

  db.svc.entities.AwardSubmission.updateMany = async (query, update) => {
    arrived++;
    if (arrived === 1) {
      // O primeiro request PARA antes de aplicar o CAS — o segundo entra agora.
      signalSecond();
      await firstGate;
    }
    return original(query, update);
  };

  const payload = { submission_id: "sub_1", reviewer_user_id: "u_rev", total_score: 10 };
  const a = saveEvaluationOnce(db.svc, { submissionId: "sub_1", reviewerUserId: "u_rev", payload });
  await secondArrived;
  const b = saveEvaluationOnce(db.svc, {
    submissionId: "sub_1",
    reviewerUserId: "u_rev",
    payload: { ...payload, total_score: 12 },
  });
  await Promise.resolve();
  openFirstGate();

  const [ra, rb] = await Promise.all([a, b]);
  // A garantia: NUNCA duas avaliações. Quem perde o claim recebe `claim_busy`
  // (retryável) — não cria, não sobrescreve e não devolve sucesso falso.
  assert.equal([ra, rb].filter((r) => r.ok).length, 1, "exatamente uma execução grava");
  assert.equal([ra, rb].filter((r) => !r.ok && r.reason === "claim_busy").length, 1);
  assert.equal(db.awardEvaluations.length, 1, "NUNCA existem duas avaliações para o mesmo par");
  assert.equal([ra, rb].filter((r) => r.created).length, 1, "apenas uma execução cria");
  assert.equal(db.awardSubmissions[0].evaluation_claims.length, 0, "o claim é devolvido ao final");
});

test("(4) crash do proprietário: o claim fica, vence e a próxima execução conclui", async () => {
  const db = evalDb();
  const a = await acquireEvaluationClaim(db.svc, { submissionId: "sub_1", reviewerUserId: "u_rev", nowMs: T0 });
  assert.equal(a.ok, true);
  assert.deepEqual(db.awardSubmissions[0].evaluation_claims, ["u_rev"]);

  const out = await saveEvaluationOnce(db.svc, {
    submissionId: "sub_1",
    reviewerUserId: "u_rev",
    payload: { submission_id: "sub_1", reviewer_user_id: "u_rev", total_score: 9 },
    nowMs: T0 + EVALUATION_CLAIM_TTL_MS + 1000,
  });
  assert.equal(out.ok, true, "a execução seguinte retoma o claim vencido");
  assert.equal(db.awardEvaluations.length, 1);
  assert.equal(db.awardSubmissions[0].evaluation_claims.length, 0);
});

test("(5) falha na CONFIRMAÇÃO (post-read) não é reportada como sucesso — e o retry converge", async () => {
  const db = evalDb();
  const originalFilter = db.svc.entities.AwardEvaluation.filter;
  let calls = 0;
  const svc = {
    entities: {
      ...db.svc.entities,
      AwardEvaluation: {
        ...db.svc.entities.AwardEvaluation,
        filter: async (...args) => {
          calls++;
          if (calls === 2) throw new Error("leitura de confirmação indisponível");
          return originalFilter(...args);
        },
      },
    },
  };
  const payload = { submission_id: "sub_1", reviewer_user_id: "u_rev", total_score: 10 };
  const out = await saveEvaluationOnce(svc, { submissionId: "sub_1", reviewerUserId: "u_rev", payload });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "confirm_unavailable");
  assert.equal(db.awardSubmissions[0].evaluation_claims.length, 0, "o claim é devolvido mesmo na falha");

  const retry = await saveEvaluationOnce(db.svc, { submissionId: "sub_1", reviewerUserId: "u_rev", payload });
  assert.equal(retry.ok, true);
  assert.equal(retry.created, false, "o retry ATUALIZA o que já foi gravado");
  assert.equal(db.awardEvaluations.length, 1, "a falha de confirmação não duplicou nada");
});

test("(6) avaliação soft-deleted não conta como válida: a gravação cria a nova", async () => {
  const db = evalDb({
    awardEvaluations: [evaluation({ id: "ae_old", is_deleted: true, total_score: 3 })],
  });
  const out = await saveEvaluationOnce(db.svc, {
    submissionId: "sub_1",
    reviewerUserId: "u_rev",
    payload: { submission_id: "sub_1", reviewer_user_id: "u_rev", total_score: 18 },
  });
  assert.equal(out.ok, true);
  assert.equal(out.created, true);
  const active = db.awardEvaluations.filter((r) => r.is_deleted !== true);
  assert.equal(active.length, 1);
  assert.equal(active[0].total_score, 18);
});

test("(7) gravações concorrentes com score: apenas UMA avaliação pontuável", async () => {
  const db = evalDb();
  const build = (score) => ({ submission_id: "sub_1", reviewer_user_id: "u_rev", total_score: score });
  const results = await Promise.all([
    saveEvaluationOnce(db.svc, { submissionId: "sub_1", reviewerUserId: "u_rev", payload: build(20) }),
    saveEvaluationOnce(db.svc, { submissionId: "sub_1", reviewerUserId: "u_rev", payload: build(20) }),
    saveEvaluationOnce(db.svc, { submissionId: "sub_1", reviewerUserId: "u_rev", payload: build(20) }),
  ]);
  assert.equal(results.some((r) => r.ok), true, "ao menos uma execução conclui");
  assert.equal(
    results.filter((r) => !r.ok).every((r) => r.reason === "claim_busy"),
    true,
    "as perdedoras recebem claim_busy (retryável), nunca sucesso",
  );
  const scored = dedupeEvaluationsForScoring(db.awardEvaluations.filter((r) => r.is_deleted !== true));
  assert.equal(scored.length, 1);
  assert.equal(scored.reduce((s, r) => s + r.total_score, 0), 20, "o score não infla");
});

test("(8) claim indisponível é recusa explícita (nada é gravado)", async () => {
  const db = evalDb();
  const svc = {
    entities: {
      ...db.svc.entities,
      EvaluationClaim: { ...db.svc.entities.EvaluationClaim, create: async () => { throw new Error("escrita indisponível"); } },
    },
  };
  const out = await saveEvaluationOnce(svc, {
    submissionId: "sub_1",
    reviewerUserId: "u_rev",
    payload: { submission_id: "sub_1", reviewer_user_id: "u_rev", total_score: 10 },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "claim_unavailable");
  assert.equal(db.awardEvaluations.length, 0);
});

test("(9) HTTP: avaliação em andamento devolve 409 e nada é gravado", async () => {
  const client = awardClient(REVIEWER, {
    submission: { evaluation_claims: ["u_rev"] },
    evaluationClaims: [{
      id: "ec_1",
      submission_id: "sub_1",
      reviewer_user_id: "u_rev",
      state: "held",
      token: "tok_other",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      attempts: 1,
      is_deleted: false,
    }],
  });
  const res = await invoke(manageAward, client.base44, {
    action: "saveEvaluation", submission_id: "sub_1", scores: { c1: 5 },
  });
  assert.equal(res.status, 409);
  assert.equal(res.data.reason, "claim_busy");
  assert.equal(client.rows.AwardEvaluation.length, 0);
});

test("(10) claim é liberado ao fim da gravação (slot e lease)", async () => {
  const db = evalDb();
  const out = await saveEvaluationOnce(db.svc, {
    submissionId: "sub_1",
    reviewerUserId: "u_rev",
    payload: { submission_id: "sub_1", reviewer_user_id: "u_rev", total_score: 11 },
  });
  assert.equal(out.ok, true);
  assert.equal(db.awardSubmissions[0].evaluation_claims.length, 0);
  assert.equal(db.evaluationClaims.length, 1);
  assert.equal(db.evaluationClaims[0].state, "released");
  assert.equal(db.evaluationClaims[0].release_reason, "saved");
  assert.equal(db.awardEvaluations[0].claim_token, out.claimToken, "o token da execução fica na nota");
});