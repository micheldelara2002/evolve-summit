// Fase 3 (Etapas 3.4 e 3.5) — regressão das correções desta rodada.
//
// Exercita MÓDULOS DE PRODUÇÃO:
//   - base44/shared/anonymization.ts   (marcadores de anonimização)
//   - base44/shared/auditTrail.ts      (trilha obrigatória idempotente)
//
// O que prova: a anonimização não preserva nem deriva o dado original, e a
// trilha obrigatória é idempotente por chave e falha de forma explícita
// (AuditUnavailableError) quando não consegue confirmar a gravação — nunca
// silenciosa. O que NÃO prova: RLS real, concorrência de banco, nem que a
// função deleteMyAccount executa em produção.
//
// Execução: npm run test:unit:fase3

import test from "node:test";
import assert from "node:assert/strict";

import {
  DELETED_EMAIL_MARKER,
  DELETED_NAME,
  jobPostingAuthorAnon,
  submissionAuthorAnon,
} from "../../base44/shared/anonymization.ts";
import {
  AuditUnavailableError,
  buildAuditKey,
  writeMandatoryAudit,
} from "../../base44/shared/auditTrail.ts";

// ---------------------------------------------------------------------------
// Fake mínimo de AuditLog: só o que a trilha obrigatória usa.
// ---------------------------------------------------------------------------
function fakeSvc(initial = []) {
  const rows = [...initial];
  let seq = 0;
  return {
    rows,
    entities: {
      AuditLog: {
        filter: async (q) => rows.filter((r) => r.audit_key === q.audit_key),
        create: async (data) => {
          const row = { id: `audit_${++seq}`, created_date: new Date(Date.now() + seq).toISOString(), ...data };
          rows.push(row);
          return row;
        },
        delete: async (id) => {
          const i = rows.findIndex((r) => r.id === id);
          if (i >= 0) rows.splice(i, 1);
          return { deleted: i >= 0 };
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 1–4. Anonimização (LGPD)
// ---------------------------------------------------------------------------

test("1 — autoria de proposta e de case perde nome e e-mail originais", () => {
  const submission = submissionAuthorAnon("sub_1");
  const award = submissionAuthorAnon("award_sub_1");

  for (const payload of [submission, award]) {
    assert.equal(payload.submitter_name, DELETED_NAME);
    assert.equal(payload.submitter_email, DELETED_EMAIL_MARKER);
    assert.ok(!JSON.stringify(payload).includes("@"), "nenhum endereço de e-mail remanescente");
  }
  assert.equal(submission.id, "sub_1", "id preservado para histórico");
  assert.equal(award.id, "award_sub_1");
});

test("2 — vaga de emprego perde nome e e-mail de contato do anunciante", () => {
  const job = jobPostingAuthorAnon("job_1");

  assert.deepEqual(job, {
    id: "job_1",
    poster_name: DELETED_NAME,
    contact_email: DELETED_EMAIL_MARKER,
  });
  assert.ok(!JSON.stringify(job).includes("@"));
});

test("3 — marcador de e-mail não é endereço válido (não permite reenvio nem login)", () => {
  assert.equal(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(DELETED_EMAIL_MARKER), false);
});

test("4 — marcador de nome não carrega o nome original por substring", () => {
  const original = "Maria Souza Lima";
  const anon = submissionAuthorAnon("sub_2");
  const serialized = JSON.stringify(anon).toLowerCase();

  for (const part of original.toLowerCase().split(" ")) {
    assert.equal(serialized.includes(part), false, `fragmento "${part}" não deve aparecer`);
  }
});

// ---------------------------------------------------------------------------
// 5–9. Trilha obrigatória (auditoria)
// ---------------------------------------------------------------------------

test("5 — chave determinística: mesma operação, mesma referência, mesma chave", () => {
  assert.equal(buildAuditKey("certificado_emitido", "cert_1"), "certificado_emitido|cert_1");
  assert.equal(
    buildAuditKey("certificado_emitido", "cert_1"),
    buildAuditKey("certificado_emitido", "cert_1"),
    "repetir a operação não gera chave nova",
  );
  assert.notEqual(
    buildAuditKey("certificado_emitido", "cert_1"),
    buildAuditKey("certificado_emitido", "cert_2"),
  );
});

test("6 — trilha gravada uma única vez por chave (reexecução é no-op)", async () => {
  const svc = fakeSvc();
  const entry = {
    action: "create",
    entity_type: "Certificate",
    entity_id: "cert_1",
    user_id: "user_1",
    event_id: "ev_1",
    audit_key: buildAuditKey("certificado_emitido", "cert_1"),
    details: JSON.stringify({ tipo: "participacao" }),
  };

  const first = await writeMandatoryAudit(svc, entry);
  const second = await writeMandatoryAudit(svc, entry);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true, "segunda gravação reconhecida como duplicata");
  assert.equal(second.id, first.id);
  assert.equal(svc.rows.length, 1, "nenhum registro duplicado");
  assert.equal(svc.rows[0].mandatory, true);
  assert.equal(svc.rows[0].status, "recorded");
});

test("7 — falha de gravação é EXPLÍCITA (nunca silenciosa)", async () => {
  const svc = fakeSvc();
  svc.entities.AuditLog.create = async () => { throw new Error("trilha indisponível"); };

  await assert.rejects(
    () => writeMandatoryAudit(svc, {
      action: "create",
      entity_type: "Certificate",
      entity_id: "cert_9",
      user_id: "user_1",
      event_id: "ev_1",
      audit_key: buildAuditKey("certificado_emitido", "cert_9"),
    }),
    (err) => err instanceof AuditUnavailableError && /trilha indisponível|Falha ao gravar/i.test(err.message),
  );
  assert.equal(svc.rows.length, 0, "nada gravado parcialmente");
});

test("8 — falha de leitura também impede declarar sucesso", async () => {
  const svc = fakeSvc();
  svc.entities.AuditLog.filter = async () => { throw new Error("banco indisponível"); };

  await assert.rejects(
    () => writeMandatoryAudit(svc, {
      action: "create",
      entity_type: "Certificate",
      entity_id: "cert_10",
      user_id: "user_1",
      event_id: "ev_1",
      audit_key: buildAuditKey("certificado_emitido", "cert_10"),
    }),
    (err) => err instanceof AuditUnavailableError,
  );
});

test("9 — entrada sem chave é recusada (não grava trilha sem idempotência)", async () => {
  const svc = fakeSvc();

  await assert.rejects(
    () => writeMandatoryAudit(svc, {
      action: "create",
      entity_type: "Certificate",
      entity_id: "cert_11",
      user_id: "user_1",
    }),
    (err) => err instanceof AuditUnavailableError && /audit_key/i.test(err.message),
  );
  assert.equal(svc.rows.length, 0);
});