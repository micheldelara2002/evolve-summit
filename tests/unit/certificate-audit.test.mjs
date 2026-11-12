// F3-09 (rodada de correção 2026-11-12) — TRILHA DE CERTIFICADO COM ESTADO
// RASTREÁVEL ATÉ O FIM (inclusive quando a principal E a pendência falham).
//
// Exercita os módulos de produção `base44/shared/certificateAudit.ts` e
// `base44/shared/auditTrail.ts` contra um fake em memória, e verifica o ESTADO
// FINAL DAS ENTIDADES em cada combinação de falha.
//
// O que estes testes provam: existe exatamente um desfecho por cenário —
// trilha gravada, pendência confirmada por leitura, ou falha explícita;
// reprocessamento recupera o caso sem duplicar trilha.
// O que NÃO provam: falha real do provedor de banco, concorrência real entre
// dois emissores, nem execução da função HTTP completa (ver relatório).

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAuditKey,
  resolvePendingTrails,
  AuditUnavailableError,
} from "../../base44/shared/auditTrail.ts";
import { auditCertificateIssuance } from "../../base44/shared/certificateAudit.ts";

const CERT_ID = "cert_abc123";
const EVENT = "64b7f0c2a1b2c3d4e5f60718";

function createFakeAuditDb() {
  const logs = [];
  let seq = 0;
  const mode = {
    failCreate: null, // (data) => boolean
    failFilter: null, // (query) => boolean
  };

  const matches = (row, query = {}) =>
    Object.entries(query || {}).every(([k, v]) => String(row[k]) === String(v));

  const svc = {
    entities: {
      AuditLog: {
        async create(data) {
          if (mode.failCreate && mode.failCreate(data)) {
            throw new Error("criação de trilha indisponível");
          }
          const rec = { id: `log_${++seq}`, created_date: `2026-11-12T18:00:0${seq}Z`, ...data };
          logs.push(rec);
          return rec;
        },
        async filter(query = {}, _sort, limit, _skip) {
          if (mode.failFilter && mode.failFilter(query)) {
            throw new Error("leitura de trilha indisponível");
          }
          const rows = logs.filter((r) => matches(r, query));
          return typeof limit === "number" ? rows.slice(0, limit) : rows;
        },
        async update(id, patch) {
          const row = logs.find((r) => r.id === id);
          if (row) Object.assign(row, patch);
          return row;
        },
        async delete(id) {
          const i = logs.findIndex((r) => r.id === id);
          if (i >= 0) logs.splice(i, 1);
          return true;
        },
      },
    },
  };

  return { svc, logs, mode };
}

function entry(over = {}) {
  return {
    action: "create",
    entity_type: "Certificate",
    entity_id: CERT_ID,
    user_id: "user_mgr",
    user_name: "Gerente",
    event_id: EVENT,
    audit_key: buildAuditKey("certificado_emitido", CERT_ID),
    details: JSON.stringify({ tipo: "participacao", participant_id: "part_1" }),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. Auditoria principal funcionando
// ---------------------------------------------------------------------------

test("1 — trilha principal gravada: um registro crítico, nenhuma pendência", async () => {
  const db = createFakeAuditDb();

  const out = await auditCertificateIssuance(db.svc, entry());

  assert.equal(out.state, "recorded");
  assert.ok(out.audit_id);
  assert.equal(out.pending_id, null);

  assert.equal(db.logs.length, 1);
  const log = db.logs[0];
  assert.equal(log.status, "recorded");
  assert.equal(log.mandatory, true);
  assert.equal(log.audit_key, `certificado_emitido|${CERT_ID}`);
  assert.equal(log.entity_type, "Certificate");
  assert.equal(log.entity_id, CERT_ID);
  assert.equal(log.event_id, EVENT);
  assert.equal(log.user_id, "user_mgr");
});

// ---------------------------------------------------------------------------
// 2. Principal falha, pendência persiste e é confirmada
// ---------------------------------------------------------------------------

test("2 — principal falha: pendência PERSISTIDA e confirmada por leitura", async () => {
  const db = createFakeAuditDb();
  db.mode.failCreate = (data) => data.status === "recorded";

  const out = await auditCertificateIssuance(db.svc, entry());

  assert.equal(out.state, "pending");
  assert.equal(out.audit_id, null);
  assert.ok(out.pending_id);

  assert.equal(db.logs.length, 1, "exatamente uma pendência");
  const pending = db.logs[0];
  assert.equal(pending.status, "pending");
  assert.equal(pending.mandatory, true);
  assert.equal(pending.audit_key, `certificado_emitido|${CERT_ID}|pending`);
  assert.match(pending.failure_reason, /indisponível/);

  // A entrada original é preservada para a reconciliação regravar.
  const original = JSON.parse(pending.details).entry;
  assert.equal(original.audit_key, `certificado_emitido|${CERT_ID}`);
  assert.equal(original.entity_id, CERT_ID);
  assert.equal(original.user_id, "user_mgr");
});

// ---------------------------------------------------------------------------
// 3. Principal E pendência falham
// ---------------------------------------------------------------------------

test("3 — principal e pendência falham: falha EXPLÍCITA, nada declarado auditado", async () => {
  const db = createFakeAuditDb();
  db.mode.failCreate = () => true;

  await assert.rejects(
    () => auditCertificateIssuance(db.svc, entry()),
    (err) => {
      assert.ok(err instanceof AuditUnavailableError, "erro tipado de trilha indisponível");
      assert.match(err.message, /principal e pendência/);
      return true;
    },
  );

  assert.equal(db.logs.length, 0, "nenhuma evidência persistida");
});

// ---------------------------------------------------------------------------
// 4. Falha de LEITURA após tentativa de gravação
// ---------------------------------------------------------------------------

test("4 — falha de leitura após gravação: pendência existe mas NÃO é confirmada → falha explícita", async () => {
  const db = createFakeAuditDb();
  // Gravação funciona; leitura sempre falha → nada pode ser confirmado.
  db.mode.failFilter = () => true;

  await assert.rejects(
    () => auditCertificateIssuance(db.svc, entry()),
    (err) => err instanceof AuditUnavailableError,
  );

  // A linha pode existir fisicamente, mas sem confirmação ela NÃO é declarada
  // auditada; a reconciliação a encontra por varredura.
  assert.equal(db.logs.length, 1);
  assert.equal(db.logs[0].status, "pending");
});

// ---------------------------------------------------------------------------
// 5. Reprocessamento da pendência (reconciliação)
// ---------------------------------------------------------------------------

test("5 — reconciliação conclui a pendência sem duplicar trilha", async () => {
  const db = createFakeAuditDb();
  db.mode.failCreate = (data) => data.status === "recorded";
  const out = await auditCertificateIssuance(db.svc, entry());
  assert.equal(out.state, "pending");

  // Trilha volta a funcionar.
  db.mode.failCreate = null;

  const first = await resolvePendingTrails(db.svc, 50);
  assert.equal(first.resolved, 1);
  assert.equal(first.failed, 0);

  const recorded = db.logs.filter((l) => l.status === "recorded");
  assert.equal(recorded.length, 1, "uma única trilha principal");
  assert.equal(recorded[0].audit_key, `certificado_emitido|${CERT_ID}`);

  const pending = db.logs.find((l) => l.status === "resolved");
  assert.ok(pending, "pendência marcada como resolvida");
  assert.equal(pending.audit_key, `certificado_emitido|${CERT_ID}|pending`);

  // Segunda execução: nada pendente, nada duplicado.
  const second = await resolvePendingTrails(db.svc, 50);
  assert.equal(second.examined, 0);
  assert.equal(db.logs.filter((l) => l.status === "recorded").length, 1);
});

// ---------------------------------------------------------------------------
// 6. Reexecução da emissão (mesma chave determinística)
// ---------------------------------------------------------------------------

test("6 — reexecução da auditoria da emissão não duplica trilha", async () => {
  const db = createFakeAuditDb();

  const a = await auditCertificateIssuance(db.svc, entry());
  const b = await auditCertificateIssuance(db.svc, entry());

  assert.equal(a.state, "recorded");
  assert.equal(b.state, "recorded");
  assert.equal(a.audit_id, b.audit_id, "mesma trilha nas duas execuções");
  assert.equal(db.logs.filter((l) => l.status === "recorded").length, 1);
  assert.equal(db.logs.length, 1, "nenhum registro extra");
});

// ---------------------------------------------------------------------------
// 7. Recuperação após falha total por nova tentativa de emissão
// ---------------------------------------------------------------------------

test("7 — falha total e depois recuperação: a nova tentativa grava a trilha, sem duplicar", async () => {
  const db = createFakeAuditDb();
  db.mode.failCreate = () => true;
  await assert.rejects(() => auditCertificateIssuance(db.svc, entry()), AuditUnavailableError);

  db.mode.failCreate = null;
  const recovered = await auditCertificateIssuance(db.svc, entry());

  assert.equal(recovered.state, "recorded");
  assert.equal(db.logs.length, 1);
  assert.equal(db.logs[0].status, "recorded");
  assert.equal(db.logs[0].audit_key, `certificado_emitido|${CERT_ID}`);
});

// ---------------------------------------------------------------------------
// 8. Pendência cuja leitura falha no momento da reconciliação
// ---------------------------------------------------------------------------

test("8 — reconciliação com leitura/gravação indisponível não perde nem duplica o caso", async () => {
  const db = createFakeAuditDb();
  db.mode.failCreate = (data) => data.status === "recorded";
  await auditCertificateIssuance(db.svc, entry());

  // Reconciliador roda com o banco ainda indisponível para gravar trilha.
  const failedRun = await resolvePendingTrails(db.svc, 50);
  assert.equal(failedRun.resolved, 0);
  assert.equal(failedRun.failed, 1);
  assert.equal(db.logs.length, 1, "caso continua pendente, não desaparece");
  assert.equal(db.logs[0].status, "pending");

  // Quando o banco volta, o mesmo caso é concluído.
  db.mode.failCreate = null;
  const okRun = await resolvePendingTrails(db.svc, 50);
  assert.equal(okRun.resolved, 1);
  assert.equal(db.logs.filter((l) => l.status === "recorded").length, 1);
});