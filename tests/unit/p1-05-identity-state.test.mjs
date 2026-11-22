// P1-05 (AUD-04) — estado explícito da resolução de identidade.
// A distinção entre "não existe Person" e "não consegui consultar" é o que
// impede a exclusão LGPD de prosseguir com um conjunto incompleto.

import test from "node:test";
import assert from "node:assert/strict";

import { resolveIdentity, identitySetIsComplete } from "../../base44/shared/identity.ts";

function client({ persons = [], failEmail = false, failLinked = false } = {}) {
  return {
    asServiceRole: {
      entities: {
        Person: {
          async filter(query = {}) {
            if (query.id) {
              if (failLinked) throw new Error("timeout no vínculo");
              return persons.filter((p) => p.id === query.id);
            }
            if (failEmail) throw new Error("permission denied");
            const wanted = (query.contact_email && query.contact_email.$in) || [];
            return persons.filter(
              (p) => wanted.map(String).includes(String(p.contact_email)) && p.is_active !== false,
            );
          },
        },
      },
    },
  };
}

const USER = { id: "u_1", email: "Ana@Example.com", person_id: "" };

test("P1-05 — identidade resolvida por e-mail (uma Person)", async () => {
  const id = await resolveIdentity(client({
    persons: [{ id: "person_a", contact_email: "ana@example.com", is_active: true }],
  }), USER);

  assert.equal(id.state, "resolved");
  assert.deepEqual(id.personIds, ["person_a"]);
  assert.equal(id.selfPersonId, "person_a");
  assert.deepEqual(id.lookupErrors, []);
  assert.equal(identitySetIsComplete(id), true);
});

test("P1-05 — ausência REAL de Person é no_person (conjunto completo)", async () => {
  const id = await resolveIdentity(client({ persons: [] }), USER);

  assert.equal(id.state, "no_person");
  assert.equal(id.reason, "no_person");
  assert.equal(identitySetIsComplete(id), true, "ausência confirmada permite prosseguir");
});

test("P1-05 — múltiplas Persons é ambiguous (conjunto completo)", async () => {
  const id = await resolveIdentity(client({
    persons: [
      { id: "person_a", contact_email: "ana@example.com", is_active: true },
      { id: "person_b", contact_email: "ana@example.com", is_active: true },
    ],
  }), USER);

  assert.equal(id.state, "ambiguous");
  assert.equal(id.ambiguous, true);
  assert.equal(id.personIds.length, 2);
  assert.equal(identitySetIsComplete(id), true);
});

test("P1-05 — falha de consulta sem nenhuma Person é unavailable (fail-closed)", async () => {
  const id = await resolveIdentity(client({ persons: [], failEmail: true }), USER);

  assert.equal(id.state, "unavailable");
  assert.equal(identitySetIsComplete(id), false, "erro de leitura não é ausência de dados");
  assert.equal(id.lookupErrors.length, 1);
  assert.match(id.lookupErrors[0], /email_person/);
});

test("P1-05 — falha de consulta com Person encontrada é partial (conjunto incompleto)", async () => {
  const id = await resolveIdentity(client({
    persons: [{ id: "person_linked", contact_email: "outro@example.com", is_active: true }],
    failEmail: true,
  }), { ...USER, person_id: "person_linked" });

  assert.equal(id.state, "partial");
  assert.deepEqual(id.personIds, ["person_linked"]);
  assert.equal(identitySetIsComplete(id), false, "pode faltar Person por e-mail");
});

test("P1-05 — falha no vínculo explícito também é partial", async () => {
  const id = await resolveIdentity(client({
    persons: [{ id: "person_a", contact_email: "ana@example.com", is_active: true }],
    failLinked: true,
  }), { ...USER, person_id: "person_linked" });

  assert.equal(id.state, "partial");
  assert.equal(identitySetIsComplete(id), false);
  assert.match(id.lookupErrors.join(" "), /linked_person/);
});

test("P1-05 — sem usuário autenticado é no_user", async () => {
  const id = await resolveIdentity(client({}), null);
  assert.equal(id.state, "no_user");
  assert.equal(identitySetIsComplete(id), false);
});