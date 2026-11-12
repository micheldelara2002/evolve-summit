// F3-07 (rodada de correção 2026-11-12) — ANONIMIZAÇÃO DE AUTORIA NA EXCLUSÃO
// DE CONTA, validada no nível de INTEGRAÇÃO (fluxo real, banco simulado).
//
// Exercita `base44/shared/anonymization.ts` → `anonymizeAuthoredContent`, que é
// exatamente o passo 9d de `deleteMyAccount`. Antes os testes só cobriam os
// construtores de marcador; aqui o fluxo inteiro é executado: busca por
// person_id, busca por variantes de e-mail, deduplicação entre consultas,
// lotes, paginação, dryRun, falha parcial e reexecução.
//
// O que NÃO é executado (e fica documentado no relatório): a função HTTP
// `deleteMyAccount` completa (guard de conta, resolução de identidade, escrita
// do AuditLog final e marcação account_status='deleted') exige sessão real e
// exclusão de usuário — proibidas nesta rodada.

import test from "node:test";
import assert from "node:assert/strict";

import {
  anonymizeAuthoredContent,
  DELETED_NAME,
  DELETED_EMAIL_MARKER,
} from "../../base44/shared/anonymization.ts";

function matches(row, query = {}) {
  return Object.entries(query || {}).every(([key, cond]) => {
    if (cond && typeof cond === "object" && "$in" in cond) {
      return cond.$in.map(String).includes(String(row[key]));
    }
    return String(row[key]) === String(cond);
  });
}

function createFakeDb(seed = {}) {
  const data = {
    Submission: seed.submissions || [],
    AwardSubmission: seed.awardSubmissions || [],
    JobPosting: seed.jobPostings || [],
  };
  const mode = { failBulkOnCall: null, failFilter: false };
  const stats = { bulkCalls: 0, updated: 0, filters: 0 };

  const makeStore = (name) => ({
    rows: data[name],
    async filter(query = {}, _sort, limit, skip) {
      if (mode.failFilter) throw new Error("leitura indisponível");
      stats.filters++;
      const matched = data[name].filter((row) => matches(row, query));
      const start = Number(skip) || 0;
      return typeof limit === "number" ? matched.slice(start, start + limit) : matched.slice(start);
    },
    async bulkUpdate(updates) {
      stats.bulkCalls++;
      if (mode.failBulkOnCall === stats.bulkCalls) throw new Error("falha no lote");
      for (const update of updates) {
        const row = data[name].find((r) => r.id === update.id);
        if (row) Object.assign(row, update);
      }
      stats.updated += updates.length;
      return updates.length;
    },
  });

  const svc = {
    entities: {
      Submission: makeStore("Submission"),
      AwardSubmission: makeStore("AwardSubmission"),
      JobPosting: makeStore("JobPosting"),
    },
  };

  return { svc, data, mode, stats };
}

const PERSON_A = "person_a";
const PERSON_B = "person_b";
const EMAIL_A = "pessoa.a@example.com";

// ---------------------------------------------------------------------------
// 1. Usuário com UMA Person
// ---------------------------------------------------------------------------

test("1 — uma Person: propostas, cases e vagas dela perdem nome e e-mail", async () => {
  const db = createFakeDb({
    submissions: [{ id: "sub_1", person_id: PERSON_A, submitter_name: "Ana Silva", submitter_email: EMAIL_A, title: "Palestra" }],
    awardSubmissions: [{ id: "award_1", person_id: PERSON_A, submitter_name: "Ana Silva", submitter_email: EMAIL_A, title: "Case" }],
    jobPostings: [{ id: "job_1", person_id: PERSON_A, poster_name: "Ana Silva", contact_email: EMAIL_A, title: "Vaga" }],
  });

  const counts = await anonymizeAuthoredContent(db.svc, {
    personIds: [PERSON_A],
    emailVariants: [EMAIL_A],
  });

  assert.deepEqual(counts, { submissions: 1, awardSubmissions: 1, jobPostings: 1 });

  const sub = db.data.Submission[0];
  assert.equal(sub.submitter_name, DELETED_NAME);
  assert.equal(sub.submitter_email, DELETED_EMAIL_MARKER);
  assert.equal(sub.title, "Palestra", "conteúdo preservado");

  const award = db.data.AwardSubmission[0];
  assert.equal(award.submitter_name, DELETED_NAME);
  assert.equal(award.submitter_email, DELETED_EMAIL_MARKER);
  assert.equal(award.title, "Case");

  const job = db.data.JobPosting[0];
  assert.equal(job.poster_name, DELETED_NAME);
  assert.equal(job.contact_email, DELETED_EMAIL_MARKER);
  assert.equal(job.title, "Vaga");
});

// ---------------------------------------------------------------------------
// 2. Usuário com MÚLTIPLAS Persons
// ---------------------------------------------------------------------------

test("2 — múltiplas Persons: registros de todas são anonimizados", async () => {
  const db = createFakeDb({
    submissions: [
      { id: "sub_a", person_id: PERSON_A, submitter_name: "Ana", submitter_email: EMAIL_A },
      { id: "sub_b", person_id: PERSON_B, submitter_name: "Ana B", submitter_email: "outro@example.com" },
      { id: "sub_c", person_id: "person_outra", submitter_name: "Terceiro", submitter_email: "t@example.com" },
    ],
  });

  const counts = await anonymizeAuthoredContent(db.svc, {
    personIds: [PERSON_A, PERSON_B],
    emailVariants: [],
  });

  assert.equal(counts.submissions, 2);
  assert.equal(db.data.Submission[0].submitter_name, DELETED_NAME);
  assert.equal(db.data.Submission[1].submitter_name, DELETED_NAME);
  assert.equal(db.data.Submission[2].submitter_name, "Terceiro", "terceiro intacto");
});

// ---------------------------------------------------------------------------
// 3. Registros encontrados APENAS por e-mail
// ---------------------------------------------------------------------------

test("3 — registro sem person_id é alcançado pelas variantes de e-mail", async () => {
  const db = createFakeDb({
    submissions: [
      { id: "sub_legado", person_id: "", submitter_name: "Ana", submitter_email: "Pessoa.A@Example.com" },
    ],
    jobPostings: [
      { id: "job_legado", person_id: null, poster_name: "Ana", contact_email: "pessoa.a@example.com" },
    ],
  });

  const counts = await anonymizeAuthoredContent(db.svc, {
    personIds: [PERSON_A],
    emailVariants: ["pessoa.a@example.com", "Pessoa.A@Example.com"],
  });

  assert.equal(counts.submissions, 1);
  assert.equal(counts.jobPostings, 1);
  assert.equal(db.data.Submission[0].submitter_email, DELETED_EMAIL_MARKER);
  assert.equal(db.data.JobPosting[0].contact_email, DELETED_EMAIL_MARKER);
});

// ---------------------------------------------------------------------------
// 4. Duplicidade entre consultas (person_id E e-mail)
// ---------------------------------------------------------------------------

test("4 — registro achado pelas duas consultas é contado e atualizado UMA vez", async () => {
  const db = createFakeDb({
    submissions: [
      { id: "sub_dup", person_id: PERSON_A, submitter_name: "Ana", submitter_email: EMAIL_A },
    ],
  });

  const counts = await anonymizeAuthoredContent(db.svc, {
    personIds: [PERSON_A],
    emailVariants: [EMAIL_A],
  });

  assert.equal(counts.submissions, 1, "sem contagem dupla");
  assert.equal(db.stats.updated, 1, "um único update gravado");
});

// ---------------------------------------------------------------------------
// 5. Lotificação / paginação
// ---------------------------------------------------------------------------

test("5 — 1200 registros em páginas de 500: todos anonimizados, lotes corretos", async () => {
  const submissions = Array.from({ length: 1200 }, (_, i) => ({
    id: `sub_${i}`,
    person_id: PERSON_A,
    submitter_name: `Pessoa ${i}`,
    submitter_email: EMAIL_A,
  }));
  const db = createFakeDb({ submissions });

  const counts = await anonymizeAuthoredContent(db.svc, {
    personIds: [PERSON_A],
    emailVariants: [],
    pageSize: 500,
  });

  assert.equal(counts.submissions, 1200, "nenhum registro omitido pela paginação");
  assert.equal(db.stats.bulkCalls, 3, "500 + 500 + 200");
  assert.ok(db.data.Submission.every((s) => s.submitter_name === DELETED_NAME));
  assert.ok(db.data.Submission.every((s) => s.submitter_email === DELETED_EMAIL_MARKER));
});

// ---------------------------------------------------------------------------
// 6. dryRun sem nenhuma escrita
// ---------------------------------------------------------------------------

test("6 — dryRun: conta o que seria anonimizado e NÃO escreve", async () => {
  const db = createFakeDb({
    submissions: [{ id: "sub_1", person_id: PERSON_A, submitter_name: "Ana", submitter_email: EMAIL_A }],
    awardSubmissions: [{ id: "award_1", person_id: PERSON_A, submitter_name: "Ana", submitter_email: EMAIL_A }],
  });

  const counts = await anonymizeAuthoredContent(db.svc, {
    personIds: [PERSON_A],
    emailVariants: [EMAIL_A],
    dryRun: true,
  });

  assert.equal(counts.submissions, 1);
  assert.equal(counts.awardSubmissions, 1);
  assert.equal(db.stats.bulkCalls, 0, "nenhuma escrita");
  assert.equal(db.data.Submission[0].submitter_name, "Ana", "PII intacta no dryRun");
  assert.equal(db.data.AwardSubmission[0].submitter_email, EMAIL_A);
});

// ---------------------------------------------------------------------------
// 7. Falha parcial e reexecução
// ---------------------------------------------------------------------------

test("7 — falha no segundo lote propaga; reexecução conclui sem perder ninguém", async () => {
  const submissions = Array.from({ length: 700 }, (_, i) => ({
    id: `sub_${i}`,
    person_id: PERSON_A,
    submitter_name: `Pessoa ${i}`,
    submitter_email: EMAIL_A,
  }));
  const db = createFakeDb({ submissions });
  db.mode.failBulkOnCall = 2; // segundo lote falha

  await assert.rejects(
    () => anonymizeAuthoredContent(db.svc, { personIds: [PERSON_A], emailVariants: [], pageSize: 500 }),
    /falha no lote/,
  );

  const firstBatchAnon = db.data.Submission.filter((s) => s.submitter_name === DELETED_NAME).length;
  assert.equal(firstBatchAnon, 500, "primeiro lote já estava gravado");

  db.mode.failBulkOnCall = null;
  const retry = await anonymizeAuthoredContent(db.svc, {
    personIds: [PERSON_A],
    emailVariants: [],
    pageSize: 500,
  });

  assert.equal(retry.submissions, 700, "reexecução cobre todos os registros");
  assert.equal(
    db.data.Submission.filter((s) => s.submitter_name === DELETED_NAME).length,
    700,
    "nenhum registro ficou para trás",
  );
  assert.ok(
    db.data.Submission.every((s) => s.submitter_email === DELETED_EMAIL_MARKER),
    "nenhum e-mail original preservado",
  );
});

// ---------------------------------------------------------------------------
// 8. Idempotência
// ---------------------------------------------------------------------------

test("8 — reexecução após sucesso é idempotente (mesmo marcador, sem corromper)", async () => {
  const db = createFakeDb({
    submissions: [{ id: "sub_1", person_id: PERSON_A, submitter_name: "Ana", submitter_email: EMAIL_A }],
  });

  const first = await anonymizeAuthoredContent(db.svc, {
    personIds: [PERSON_A],
    emailVariants: [EMAIL_A],
  });
  const second = await anonymizeAuthoredContent(db.svc, {
    personIds: [PERSON_A],
    emailVariants: [EMAIL_A],
  });

  assert.equal(first.submissions, 1);
  assert.equal(second.submissions, 1, "reexecução reescreve o mesmo marcador");
  assert.equal(db.data.Submission[0].submitter_name, DELETED_NAME);
  assert.equal(db.data.Submission[0].submitter_email, DELETED_EMAIL_MARKER);
});

// ---------------------------------------------------------------------------
// 9. Varredura sem alvo não toca em ninguém
// ---------------------------------------------------------------------------

test("9 — sem Persons e sem e-mail: nenhuma consulta destrutiva, nada alterado", async () => {
  const db = createFakeDb({
    submissions: [{ id: "sub_1", person_id: PERSON_A, submitter_name: "Ana", submitter_email: EMAIL_A }],
  });

  const counts = await anonymizeAuthoredContent(db.svc, { personIds: [], emailVariants: [] });

  assert.deepEqual(counts, { submissions: 0, awardSubmissions: 0, jobPostings: 0 });
  assert.equal(db.stats.bulkCalls, 0);
  assert.equal(db.data.Submission[0].submitter_name, "Ana");
});