// F3-08 (rodada de correção 2026-11-12) — TRILHA DE AUDITORIA NÃO FALSIFICÁVEL.
//
// Exercita o MÓDULO DE PRODUÇÃO `base44/shared/auditLogger.ts` — o mesmo que a
// função `logAuditEvent` chama — contra um fake em memória, e verifica o
// CONTEÚDO PERSISTIDO (não só a resposta).
//
// O que estes testes provam: operação crítica não entra pela porta do cliente;
// o que entra é evento auxiliar (mandatory:false); autor, escopo e entidade são
// derivados/conferidos no servidor; entidade de outro evento é recusada.
// O que NÃO provam: RLS real da entidade (escrita direta por SDK) nem a
// existência de sessão autenticada real — ver relatório (limitações).

import test from "node:test";
import assert from "node:assert/strict";

import {
  recordClientAudit,
  classifyAuditRequest,
  CRITICAL_AUDIT_ACTIONS,
  CRITICAL_AUDIT_ENTITY_TYPES,
} from "../../base44/shared/auditLogger.ts";

const EVENT = "64b7f0c2a1b2c3d4e5f60718";
const OTHER_EVENT = "64b7f0c2a1b2c3d4e5f60719";
const MANAGER = { id: "user_mgr", full_name: "Gerente do Evento", email: "mgr@x.com", role: "user" };
const TEAM = { id: "user_team", full_name: "Equipe", email: "team@x.com", role: "user" };
const PARTICIPANT = { id: "user_part", full_name: "Participante", email: "p@x.com", role: "user" };
const ADMIN = { id: "user_admin", full_name: "Admin", email: "a@x.com", role: "admin" };

function createFakeDb(seed = {}) {
  const logs = [];
  let seq = 0;
  const makeStore = (rows = []) => ({
    rows,
    async filter(query = {}) {
      return rows.filter((r) => Object.entries(query).every(([k, v]) => String(r[k]) === String(v)));
    },
    async create(data) {
      const rec = { id: `row_${++seq}`, ...data };
      rows.push(rec);
      return rec;
    },
  });

  const svc = {
    entities: {
      AuditLog: {
        async create(data) {
          const rec = { id: `log_${++seq}`, ...data };
          logs.push(rec);
          return rec;
        },
        async filter(query = {}) {
          return logs.filter((r) => Object.entries(query).every(([k, v]) => String(r[k]) === String(v)));
        },
      },
      Participant: makeStore(seed.participants),
      Event: makeStore(seed.events),
      NotificationCampaign: makeStore(seed.campaigns),
      Submission: makeStore(seed.submissions),
      Partner: makeStore(seed.partners),
      Import: makeStore(seed.imports),
    },
  };

  return { svc, logs };
}

function baseSeed() {
  return {
    participants: [
      { id: "part_event", event_id: EVENT, email: "p@x.com", role_in_event: "attendee" },
      { id: "part_other", event_id: OTHER_EVENT, email: "o@x.com", role_in_event: "attendee" },
    ],
    events: [{ id: EVENT, name: "Evento" }, { id: OTHER_EVENT, name: "Outro" }],
    campaigns: [{ id: "camp_1", event_id: EVENT }],
    submissions: [{ id: "sub_1", event_id: EVENT }, { id: "sub_other", event_id: OTHER_EVENT }],
    partners: [{ id: "partner_1", trade_name: "Parceiro" }],
    imports: [{ id: "import_1", event_id: EVENT }, { id: "import_other", event_id: OTHER_EVENT }],
  };
}

const run = (db, over = {}) =>
  recordClientAudit(db.svc, { user: MANAGER, eventId: EVENT, ip: "203.0.113.9", body: {}, ...over });

// ---------------------------------------------------------------------------
// 1. Participante tentando registrar role_change
// ---------------------------------------------------------------------------

test("1 — participante tentando registrar role_change: recusado, nada persistido", async () => {
  const db = createFakeDb(baseSeed());

  const res = await run(db, {
    user: PARTICIPANT,
    body: { action: "role_change", entity_type: "Participant", entity_id: "part_event" },
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.match(res.error, /Operação crítica/);
  assert.equal(db.logs.length, 0, "nenhum registro gravado");
});

// ---------------------------------------------------------------------------
// 2. Manager tentando fabricar role_change
// ---------------------------------------------------------------------------

test("2 — manager tentando fabricar role_change: recusado, nada persistido", async () => {
  const db = createFakeDb(baseSeed());

  const res = await run(db, {
    body: {
      action: "role_change",
      entity_type: "Participant",
      entity_id: "part_event",
      details: { field: "role_in_event", old_value: "attendee", new_value: "manager" },
    },
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.equal(db.logs.length, 0, "role_change não ganha aparência de operação real");
});

// ---------------------------------------------------------------------------
// 3. Team tentando fabricar delete / approve
// ---------------------------------------------------------------------------

test("3 — team tentando fabricar delete e approve: recusado nas duas", async () => {
  for (const action of ["delete", "approve"]) {
    const db = createFakeDb(baseSeed());
    const res = await run(db, {
      user: TEAM,
      body: { action, entity_type: "Submission", entity_id: "sub_1" },
    });
    assert.equal(res.ok, false, `${action} recusado`);
    assert.equal(res.status, 403);
    assert.equal(db.logs.length, 0, `${action} nada persistido`);
  }
});

// ---------------------------------------------------------------------------
// 4. Manager em operação legítima (evento auxiliar)
// ---------------------------------------------------------------------------

test("4 — manager em operação legítima: evento auxiliar persistido com contexto do servidor", async () => {
  const db = createFakeDb(baseSeed());

  const res = await run(db, {
    body: {
      action: "update",
      entity_type: "Participant",
      entity_id: "part_event",
      details: { field: "company", new_value: "ACME" },
    },
  });

  assert.equal(res.ok, true, res.error);
  assert.equal(db.logs.length, 1);

  const log = db.logs[0];
  assert.equal(log.event_id, EVENT);
  assert.equal(log.action, "update");
  assert.equal(log.entity_type, "Participant");
  assert.equal(log.entity_id, "part_event");
  assert.equal(log.user_id, MANAGER.id, "autor derivado do usuário autenticado");
  assert.equal(log.user_name, MANAGER.full_name);
  assert.equal(log.mandatory, false, "nunca se confunde com trilha crítica");
  assert.equal(log.status, "recorded");
  assert.equal(log.ip_address, "203.0.113.9");
  assert.equal(JSON.parse(log.details).new_value, "ACME");
});

// ---------------------------------------------------------------------------
// 5. Tentativa de falsificar autoria / status / escopo pelo corpo
// ---------------------------------------------------------------------------

test("5 — corpo não consegue falsificar autor, status, mandatory nem event_id", async () => {
  const db = createFakeDb(baseSeed());

  const res = await run(db, {
    body: {
      action: "soft_delete",
      entity_type: "Participant",
      entity_id: "part_event",
      // Campos que o cliente tenta impor:
      user_id: "user_falso",
      user_name: "Outra Pessoa",
      event_id: OTHER_EVENT,
      status: "recorded",
      mandatory: true,
      audit_key: "forjado|1",
    },
  });

  assert.equal(res.ok, true, res.error);
  const log = db.logs[0];
  assert.equal(log.user_id, MANAGER.id, "autor não é o do corpo");
  assert.equal(log.user_name, MANAGER.full_name, "nome do autor não é o do corpo");
  assert.equal(log.event_id, EVENT, "escopo é o evento do gate, não o do corpo");
  assert.equal(log.mandatory, false, "cliente não promove evento a trilha crítica");
});

// ---------------------------------------------------------------------------
// 6. entity_id de outro evento / inexistente
// ---------------------------------------------------------------------------

test("6 — entity_id de outro evento é recusado e nada é persistido", async () => {
  const db = createFakeDb(baseSeed());

  const foreign = await run(db, {
    body: { action: "soft_delete", entity_type: "Participant", entity_id: "part_other" },
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.status, 403);
  assert.match(foreign.error, /outro evento/);

  const foreignSubmission = await run(db, {
    body: { action: "update", entity_type: "Submission", entity_id: "sub_other" },
  });
  assert.equal(foreignSubmission.ok, false);
  assert.equal(foreignSubmission.status, 403);

  const missing = await run(db, {
    body: { action: "update", entity_type: "Submission", entity_id: "sub_inexistente" },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 400);
  assert.match(missing.error, /não encontrado/);

  // Importação do próprio evento continua válida (fluxo legítimo do CsvImport);
  // a mesma ação sobre importação de OUTRO evento é recusada.
  const ownImport = await run(db, {
    body: { action: "import", entity_type: "Import", entity_id: "import_1" },
  });
  assert.equal(ownImport.ok, true, ownImport.error);

  const foreignImport = await run(db, {
    body: { action: "import", entity_type: "Import", entity_id: "import_other" },
  });
  assert.equal(foreignImport.ok, false);
  assert.equal(foreignImport.status, 403);

  assert.equal(db.logs.length, 1, "só a importação legítima foi gravada");
});

// ---------------------------------------------------------------------------
// 7. Entidades críticas e registros globais
// ---------------------------------------------------------------------------
test("7 — entidade crítica é recusada; registro global exige administrador", async () => {
  const db = createFakeDb(baseSeed());

  for (const entityType of ["Payment", "Ticket", "Certificate", "AuditLog", "User"]) {
    const res = await run(db, {
      body: { action: "update", entity_type: entityType, entity_id: "x" },
    });
    assert.equal(res.ok, false, `${entityType} recusado`);
    assert.equal(res.status, 403);
  }

  // Partner é registro global: manager não audita; admin sim.
  const asManager = await run(db, {
    body: { action: "update", entity_type: "Partner", entity_id: "partner_1" },
  });
  assert.equal(asManager.ok, false);
  assert.equal(asManager.status, 403);
  assert.match(asManager.error, /administrador/);

  const asAdmin = await run(db, {
    user: ADMIN,
    body: { action: "update", entity_type: "Partner", entity_id: "partner_1" },
  });
  assert.equal(asAdmin.ok, true, asAdmin.error);

  assert.equal(db.logs.length, 1, "só a tentativa autorizada foi gravada");
  assert.equal(db.logs[0].user_id, ADMIN.id);
});

// ---------------------------------------------------------------------------
// 8. Reexecução / ação desconhecida
// ---------------------------------------------------------------------------

test("8 — reexecução não amplifica fato crítico e ação desconhecida é inválida", async () => {
  const db = createFakeDb(baseSeed());

  // A mesma tentativa crítica repetida continua recusada (não vira histórico).
  for (let i = 0; i < 2; i++) {
    const res = await run(db, {
      body: { action: "approve", entity_type: "Submission", entity_id: "sub_1" },
    });
    assert.equal(res.ok, false);
  }
  assert.equal(db.logs.length, 0, "nenhum resquício de aprovação fabricada");

  const unknown = await run(db, {
    body: { action: "super_poder", entity_type: "Submission", entity_id: "sub_1" },
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, 400);

  // Repetição de evento AUXILIAR é permitida: é relato, não fato crítico —
  // e cada linha continua marcada como não-mandatória.
  await run(db, { body: { action: "update", entity_type: "Submission", entity_id: "sub_1" } });
  await run(db, { body: { action: "update", entity_type: "Submission", entity_id: "sub_1" } });
  assert.equal(db.logs.length, 2);
  assert.ok(db.logs.every((l) => l.mandatory === false));
});

// ---------------------------------------------------------------------------
// 9. Classificação declarativa (contrato)
// ---------------------------------------------------------------------------

test("9 — contrato da política: ações e entidades críticas fora do logger genérico", async () => {
  for (const action of ["role_change", "delete", "approve", "reject", "cancel", "account_deletion", "refund"]) {
    assert.ok(CRITICAL_AUDIT_ACTIONS.includes(action), `${action} é crítica`);
    const decision = classifyAuditRequest({ action, entityType: "Participant" });
    assert.equal(decision.ok, false);
    assert.equal(decision.status, 403);
  }
  for (const entityType of CRITICAL_AUDIT_ENTITY_TYPES) {
    const decision = classifyAuditRequest({ action: "update", entityType });
    assert.equal(decision.ok, false, `${entityType} é crítica`);
    assert.equal(decision.status, 403);
  }
  assert.equal(classifyAuditRequest({ action: "update", entityType: "Participant" }).ok, true);
  assert.equal(classifyAuditRequest({ action: "soft_delete", entityType: "Badge" }).ok, true);
  // Fluxo legítimo de importação (CsvImport) continua aceito.
  assert.equal(classifyAuditRequest({ action: "import", entityType: "Import" }).ok, true);
  assert.equal(classifyAuditRequest({ action: "", entityType: "Participant" }).ok, false);
  assert.equal(classifyAuditRequest({ action: "update", entityType: "EntidadeInexistente" }).ok, false);
});