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

  assert.equal(db.auditLogs.length, 1);
  const details = JSON.parse(db.auditLogs[0].details);
  assert.equal(details.type, "person_reactivated");
  assert.equal(details.person_id, "p_inactive");
  assert.equal(db.auditLogs[0].entity_type, "Person");
  assert.equal(db.auditLogs[0].event_id, "evt_1");
  assert.equal(db.auditLogs[0].user_id, "u_admin");
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