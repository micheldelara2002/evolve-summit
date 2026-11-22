// P2-03 (2026-11-22) — ESTADOS DA IDENTIDADE (LGPD) NA RESOLUÇÃO DE PERSON.
//
// Defeito original: a busca por e-mail filtrava `is_active: { $ne: false }`, de
// modo que cadastros INATIVOS nunca apareciam — e o ramo que deveria reativá-los
// era código morto. Quem tinha cadastro desativado ganhava uma SEGUNDA Person ao
// comprar de novo, dividindo pontos, certificados e histórico. E a Person
// anonimizada (LGPD) podia ser reativada/reutilizada, desfazendo a exclusão.
//
// Agora há três estados explícitos: ativa (reutiliza), inativa (reativa por CAS
// auditado) e anonimizada (nunca reutilizada — identidade nova).

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyPerson,
  isAnonymizedPerson,
  lookupPersonsByEmail,
  resolveOrCreatePerson,
} from "../../base44/shared/personResolution.ts";
import { resolvePendingTrails } from "../../base44/shared/auditTrail.ts";
import { createFakeDb } from "./lib/fakeDb.mjs";

const person = (over = {}) => ({
  id: "p_1",
  full_name: "Ana Souza",
  contact_email: "ana@example.com",
  is_active: true,
  is_anonymized: false,
  created_date: "2026-01-01T00:00:00.000Z",
  is_deleted: false,
  ...over,
});

const resolve = (svc, over = {}) =>
  resolveOrCreatePerson(svc, { name: "Ana Souza", email: "ana@example.com", reason: "teste", ...over });

test("classificação dos três estados", () => {
  assert.equal(classifyPerson(person()), "active");
  assert.equal(classifyPerson(person({ is_active: false })), "inactive");
  assert.equal(classifyPerson(person({ is_active: false, is_anonymized: true })), "anonymized");
  assert.equal(isAnonymizedPerson(person({ is_anonymized: true })), true);
  assert.equal(isAnonymizedPerson(person()), false);
  // anonimizada continua anonimizada mesmo se marcada ativa por engano
  assert.equal(classifyPerson(person({ is_active: true, is_anonymized: true })), "anonymized");
});

test("a busca por e-mail inclui inativas e separa anonimizadas", async () => {
  const db = createFakeDb({
    persons: [
      person({ id: "p_active" }),
      person({ id: "p_inactive", is_active: false }),
      person({ id: "p_anon", is_active: false, is_anonymized: true }),
      person({ id: "p_other", contact_email: "outra@example.com" }),
    ],
  });
  const out = await lookupPersonsByEmail(db.svc, "ana@example.com");
  assert.equal(out.ok, true);
  assert.deepEqual(out.active.map((p) => p.id), ["p_active"]);
  assert.deepEqual(out.inactive.map((p) => p.id), ["p_inactive"]);
  assert.deepEqual(out.anonymized.map((p) => p.id), ["p_anon"]);
  assert.equal(out.active.length + out.inactive.length + out.anonymized.length, 3, "outro e-mail é excluído");
});

test("cadastro ATIVO é reutilizado (nunca duplica identidade)", async () => {
  const db = createFakeDb({ persons: [person({ id: "p_active" })] });
  const out = await resolve(db.svc);
  assert.equal(out.ok, true);
  assert.equal(out.personId, "p_active");
  assert.equal(out.created, false);
  assert.equal(out.reactivated, false);
  assert.equal(db.persons.length, 1);
});

test("cadastro INATIVO é reativado por CAS com trilha (defeito original corrigido)", async () => {
  const db = createFakeDb({ persons: [person({ id: "p_inactive", is_active: false })] });
  const out = await resolve(db.svc, { actor: { id: "u_admin", name: "Gestora" }, eventId: "evt_1" });

  assert.equal(out.ok, true);
  assert.equal(out.personId, "p_inactive");
  assert.equal(out.created, false, "não cria uma segunda Person");
  assert.equal(out.reactivated, true);
  assert.equal(out.audited, true);
  assert.equal(db.persons.length, 1);
  assert.equal(db.persons[0].is_active, true);

  // P2-03 (residual) — a evidência é DURÁVEL: existe a intenção (registro
  // pendente, gravado antes da mutação) e a trilha confirmada.
  const recorded = db.auditLogs.filter((l) => l.status === "recorded");
  assert.equal(recorded.length, 1);
  const details = JSON.parse(recorded[0].details);
  assert.equal(details.type, "person_reactivated");
  assert.equal(details.person_id, "p_inactive");
  assert.ok(details.occurrence, "a ocorrência é registrada para correlação");
  assert.equal(recorded[0].entity_type, "Person");
  assert.equal(recorded[0].event_id, "evt_1");
  assert.equal(recorded[0].user_id, "u_admin");
  assert.ok(recorded[0].audit_key.startsWith("person_reactivated|p_inactive|"));

  const intents = db.auditLogs.filter((l) => l.status !== "recorded");
  assert.equal(intents.length, 1, "a intenção prévia existe e foi encerrada");
  assert.equal(intents[0].status, "resolved");
  assert.equal(out.pendingTrailId, "");
});

test("cadastro ANONIMIZADO nunca é reutilizado — cria identidade NOVA", async () => {
  const db = createFakeDb({
    persons: [person({ id: "p_anon", full_name: "Conta excluída", contact_email: "ana@example.com", is_active: false, is_anonymized: true })],
  });
  const out = await resolve(db.svc);
  assert.equal(out.ok, true);
  assert.equal(out.created, true);
  assert.notEqual(out.personId, "p_anon");
  assert.equal(db.persons.length, 2);

  const original = db.persons.find((p) => p.id === "p_anon");
  assert.equal(original.is_active, false, "a exclusão LGPD permanece");
  assert.equal(original.is_anonymized, true);
  assert.equal(original.full_name, "Conta excluída", "o registro anonimizado não é reescrito");
});

test("identidade criada nasce ativa, não anonimizada e com a chave do dia", async () => {
  const db = createFakeDb({ persons: [] });
  const out = await resolve(db.svc, { phone: "11999999999" });
  assert.equal(out.ok, true);
  assert.equal(out.created, true);
  const created = db.persons[0];
  assert.equal(created.is_active, true);
  assert.equal(created.is_anonymized, false);
  assert.equal(created.contact_email, "ana@example.com");
  assert.equal(created.phone, "11999999999");
  assert.match(created.created_day, /^\d{4}-\d{2}-\d{2}$/);
});

test("é idempotente: resolver duas vezes devolve a MESMA Person", async () => {
  const db = createFakeDb({ persons: [] });
  const first = await resolve(db.svc);
  const second = await resolve(db.svc);
  assert.equal(second.personId, first.personId);
  assert.equal(second.created, false);
  assert.equal(db.persons.length, 1);
});

test("falha de leitura é RECUSA (fail-closed), nunca criação de duplicata", async () => {
  const db = createFakeDb({ persons: [person({ id: "p_active" })] });
  const svc = {
    entities: {
      ...db.svc.entities,
      Person: { filter: async () => { throw new Error("consulta indisponível"); } },
    },
  };
  const out = await resolve(svc);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "lookup_unavailable");
  assert.equal(db.persons.length, 1);
});

test("falha ao criar é recusa explícita", async () => {
  const db = createFakeDb({ persons: [] });
  const svc = {
    entities: {
      ...db.svc.entities,
      Person: { ...db.svc.entities.Person, create: async () => { throw new Error("escrita indisponível"); } },
    },
  };
  const out = await resolve(svc);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "create_failed");
  assert.equal(db.persons.length, 0);
});

test("CAS de reativação perdido é conflito explícito (não cria duplicata)", async () => {
  const db = createFakeDb({ persons: [person({ id: "p_inactive", is_active: false })] });
  const svc = {
    entities: {
      ...db.svc.entities,
      Person: { ...db.svc.entities.Person, updateMany: async () => ({ updated: 0 }) },
    },
  };
  const out = await resolve(svc);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "reactivation_conflict");
  assert.equal(db.persons.length, 1, "nenhuma Person nova é criada no conflito");
});

test("corrida de criação converge para o sobrevivente determinístico", async () => {
  const db = createFakeDb({ persons: [] });
  const originalCreate = db.svc.entities.Person.create;
  // Simula outra requisição criando a MESMA pessoa no mesmo instante, com
  // created_date anterior — o desempate é (created_date, id).
  db.svc.entities.Person.create = async (data) => {
    const mine = await originalCreate({ ...data, id: "p_b", created_date: "2026-02-02T00:00:00.000Z" });
    await originalCreate({ ...data, id: "p_a", created_date: "2026-02-01T00:00:00.000Z" });
    return mine;
  };

  const out = await resolve(db.svc);
  assert.equal(out.ok, true);
  assert.equal(out.personId, "p_a", "sobrevive a mais antiga");
  assert.equal(out.audited, true);
  const loser = db.persons.find((p) => p.id === "p_b");
  assert.equal(loser.is_active, false, "o excedente é desativado, nunca apagado");
  const details = JSON.parse(db.auditLogs[0].details);
  assert.equal(details.type, "person_duplicate_converged");
});

test("e-mail inválido é recusado antes de qualquer leitura", async () => {
  const db = createFakeDb({ persons: [] });
  const out = await resolveOrCreatePerson(db.svc, { name: "Sem Email", email: "" });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "email_invalido");
  assert.equal(db.persons.length, 0);
});

// ===== P2-03 (residual) — EVIDÊNCIA DURÁVEL DA REATIVAÇÃO =====
//
// Antes: CAS + trilha best-effort. Uma falha do AuditLog deixava a mutação
// aplicada sem trilha e sem caminho de recuperação. Agora: INTENÇÃO durável
// confirmada por leitura ANTES da mutação → mutação idempotente → trilha
// confirmada, com a intenção permanecendo recuperável se a trilha falhar.

// Falha na gravação do AuditLog a partir da N-ésima chamada — permite simular
// "a intenção grava, a trilha não".
function auditFailAfter(db, allowedCreates) {
  const originalCreate = db.svc.entities.AuditLog.create;
  let calls = 0;
  return {
    entities: {
      ...db.svc.entities,
      AuditLog: {
        ...db.svc.entities.AuditLog,
        create: async (data) => {
          calls++;
          if (calls > allowedCreates) throw new Error("trilha indisponível");
          return originalCreate(data);
        },
      },
    },
  };
}

test("(1) intenção de auditoria indisponível BLOQUEIA a reativação (nada muda)", async () => {
  const db = createFakeDb({ persons: [person({ id: "p_inactive", is_active: false })] });
  const svc = {
    entities: {
      ...db.svc.entities,
      AuditLog: {
        ...db.svc.entities.AuditLog,
        create: async () => { throw new Error("auditoria indisponível"); },
        filter: async () => [],
      },
    },
  };
  const out = await resolve(svc, { actor: { id: "u_admin", name: "Gestora" } });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "audit_intent_unavailable");
  assert.equal(db.persons[0].is_active, false, "sem evidência durável não há reativação");
});

test("(2) reativação falha DEPOIS da intenção: a intenção é encerrada como não aplicada", async () => {
  const db = createFakeDb({ persons: [person({ id: "p_inactive", is_active: false })] });
  const svc = {
    entities: {
      ...db.svc.entities,
      Person: { ...db.svc.entities.Person, updateMany: async () => { throw new Error("escrita indisponível"); } },
    },
  };
  const out = await resolve(svc);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "reactivation_failed");
  assert.equal(db.persons[0].is_active, false);
  const intents = db.auditLogs.filter((l) => l.status !== "recorded");
  assert.equal(intents.length, 1);
  assert.equal(intents[0].status, "resolved");
  assert.match(String(intents[0].failure_reason), /não aplicada/i);
  assert.equal(db.auditLogs.filter((l) => l.status === "recorded").length, 0, "nenhuma trilha falsa é gravada");
});

test("(3) falha DEPOIS do CAS e ANTES da trilha: a operação é recuperável (intenção pendente)", async () => {
  const db = createFakeDb({ persons: [person({ id: "p_inactive", is_active: false })] });
  // A 1ª criação de AuditLog é a intenção; a 2ª seria a trilha → falha.
  const svc = auditFailAfter(db, 1);
  const out = await resolve(svc, { actor: { id: "u_admin", name: "Gestora" } });
  assert.equal(out.ok, true);
  assert.equal(out.reactivated, true);
  assert.equal(out.audited, false, "não se declara auditado sem confirmação");
  assert.ok(out.pendingTrailId, "o caso pendente é devolvido para correlação");
  assert.equal(db.persons[0].is_active, true, "a identidade foi reativada");
  assert.equal(db.auditLogs.filter((l) => l.status === "recorded").length, 0);

  // A rotina de manutenção conclui a trilha a partir da intenção durável.
  const resolution = await resolvePendingTrails(db.svc);
  assert.equal(resolution.resolved, 1);
  const recorded = db.auditLogs.filter((l) => l.status === "recorded");
  assert.equal(recorded.length, 1);
  assert.equal(JSON.parse(recorded[0].details).type, "person_reactivated");
  assert.equal(recorded[0].user_id, "u_admin", "a autoria original é preservada");
});

test("(4) retry da MESMA operação não cria segunda reativação nem segunda trilha", async () => {
  const db = createFakeDb({ persons: [person({ id: "p_inactive", is_active: false })] });
  const first = await resolve(db.svc);
  const second = await resolve(db.svc);
  assert.equal(first.reactivated, true);
  assert.equal(second.reactivated, false, "a segunda execução encontra a identidade já ativa");
  assert.equal(db.persons.length, 1);
  assert.equal(db.auditLogs.filter((l) => l.status === "recorded").length, 1);
});

test("(5) duas reativações CONCORRENTES: uma aplica, uma única trilha", async () => {
  const db = createFakeDb({ persons: [person({ id: "p_inactive", is_active: false })] });
  const [a, b] = await Promise.all([resolve(db.svc), resolve(db.svc)]);
  assert.equal([a, b].filter((r) => r.reactivated).length, 1, "só uma execução reativa");
  assert.equal([a, b].every((r) => r.ok), true);
  assert.equal(db.persons.length, 1);
  assert.equal(db.auditLogs.filter((l) => l.status === "recorded").length, 1, "nenhuma trilha duplicada");
  // Cada tentativa grava sua própria intenção; a perdedora é encerrada como NÃO
  // aplicada — nunca vira uma trilha que atribui a reativação a quem não a fez.
  const intents = db.auditLogs.filter((l) => l.status !== "recorded");
  assert.equal(intents.length, 2);
  assert.equal(intents.every((l) => l.status === "resolved"), true);
});

test("(6) anonimizada não gera NENHUMA trilha de reativação", async () => {
  const db = createFakeDb({
    persons: [person({ id: "p_anon", is_active: false, is_anonymized: true })],
  });
  const out = await resolve(db.svc);
  assert.equal(out.ok, true);
  assert.equal(out.created, true);
  assert.equal(
    db.auditLogs.filter((l) => JSON.parse(l.details || "{}").type === "person_reactivated").length,
    0,
    "a exclusão LGPD não é revertida nem registrada como reativação",
  );
});

test("(7) falha de leitura da identidade não grava intenção (nada acontece)", async () => {
  const db = createFakeDb({ persons: [person({ id: "p_inactive", is_active: false })] });
  const svc = {
    entities: {
      ...db.svc.entities,
      Person: { ...db.svc.entities.Person, filter: async () => { throw new Error("consulta indisponível"); } },
    },
  };
  const out = await resolve(svc);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "lookup_unavailable");
  assert.equal(db.auditLogs.length, 0, "sem leitura não há decisão — e sem decisão não há trilha");
});