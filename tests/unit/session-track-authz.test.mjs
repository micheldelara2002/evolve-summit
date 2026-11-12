// Fase 3 — Etapa 3.1 (Session/Track) — testes UNITÁRIOS com banco simulado.
//
// O QUE ESTES TESTES SÃO: prova da lógica de autorização/integridade executada
// nas funções de backend (referências entre eventos e revogação de participação).
//
// O QUE ESTES TESTES NÃO SÃO: prova de RLS real, nem de concorrência real, nem
// de comportamento em produção. O banco aqui é um fake em memória (mocks). A
// suíte adversarial E2E por perfil (`tests/e2e/rls-session-track-adversarial*`)
// depende de browser e contas reais e NÃO foi executada neste ambiente.

import test from "node:test";
import assert from "node:assert/strict";
import { validateSessionReferences } from "../../base44/shared/sessionAuth.ts";
import { findMyParticipants, resolveIdentity } from "../../base44/shared/identity.ts";

// ===== banco simulado mínimo (só o subconjunto de operadores usado) =====
function matches(row, cond) {
  return Object.entries(cond || {}).every(([key, expected]) => {
    const actual = row[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$in" in expected) return expected.$in.includes(actual);
      if ("$ne" in expected) return actual !== expected.$ne;
      return false;
    }
    return actual === expected;
  });
}

function makeSvc(seed) {
  const db = {
    Track: seed.Track || [],
    Room: seed.Room || [],
    Participant: seed.Participant || [],
    Person: seed.Person || [],
  };
  const entities = {};
  for (const [name, rows] of Object.entries(db)) {
    entities[name] = { filter: async (cond) => rows.filter((r) => matches(r, cond)) };
  }
  return { entities, db };
}

const EVENT_A = "ev_A";
const EVENT_B = "ev_B";

function baseSeed() {
  return {
    Track: [
      { id: "track_A", event_id: EVENT_A, name: "Trilha A", is_deleted: false },
      { id: "track_B", event_id: EVENT_B, name: "Trilha B", is_deleted: false },
      { id: "track_A_del", event_id: EVENT_A, name: "Trilha removida", is_deleted: true },
    ],
    Room: [
      { id: "room_A", event_id: EVENT_A, name: "Sala A", is_deleted: false },
      { id: "room_B", event_id: EVENT_B, name: "Sala B", is_deleted: false },
    ],
    Participant: [
      { id: "part_speaker_A", event_id: EVENT_A, person_id: "p1", email: "spk@x.com", role_in_event: "speaker", registration_status: "confirmed", is_deleted: false },
      { id: "part_speaker_B", event_id: EVENT_B, person_id: "p9", email: "spk2@x.com", role_in_event: "speaker", registration_status: "confirmed", is_deleted: false },
    ],
    Person: [{ id: "p1", contact_email: "spk@x.com", is_active: true }],
  };
}

test("1 — referências do MESMO evento são aceitas", async () => {
  const svc = makeSvc(baseSeed());
  const res = await validateSessionReferences(svc, EVENT_A, {
    track_id: "track_A", room_id: "room_A", speaker_id: "part_speaker_A",
  });
  assert.deepEqual(res, { ok: true });
});

test("2 — trilha de OUTRO evento é recusada (isolamento entre eventos)", async () => {
  const svc = makeSvc(baseSeed());
  const res = await validateSessionReferences(svc, EVENT_A, { track_id: "track_B" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /Trilha/);
});

test("3 — sala de OUTRO evento é recusada", async () => {
  const svc = makeSvc(baseSeed());
  const res = await validateSessionReferences(svc, EVENT_A, { room_id: "room_B" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /Sala/);
});

test("4 — palestrante de OUTRO evento é recusado", async () => {
  const svc = makeSvc(baseSeed());
  const res = await validateSessionReferences(svc, EVENT_A, { speaker_id: "part_speaker_B" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /Palestrante/);
});

test("5 — id inexistente (inventado) é recusado", async () => {
  const svc = makeSvc(baseSeed());
  const res = await validateSessionReferences(svc, EVENT_A, { speaker_id: "part_inventado" });
  assert.equal(res.ok, false);
});

test("6 — referência soft-deleted é recusada", async () => {
  const svc = makeSvc(baseSeed());
  const res = await validateSessionReferences(svc, EVENT_A, { track_id: "track_A_del" });
  assert.equal(res.ok, false);
});

test("7 — update parcial sem referências continua válido", async () => {
  const svc = makeSvc(baseSeed());
  const res = await validateSessionReferences(svc, EVENT_A, { title: "Novo título" });
  assert.deepEqual(res, { ok: true });
});

test("8 — tipo inválido de referência é recusado (sem chamada ao banco)", async () => {
  const svc = makeSvc(baseSeed());
  const res = await validateSessionReferences(svc, EVENT_A, { track_id: { $ne: null } });
  assert.equal(res.ok, false);
});

test("9 — eventId ausente é recusado", async () => {
  const svc = makeSvc(baseSeed());
  const res = await validateSessionReferences(svc, "", { track_id: "track_A" });
  assert.equal(res.ok, false);
});

// ===== revogação de participação (Etapa 3.1, casos 5–8 e 13) =====
test("10 — participação CANCELADA não autoriza acesso (revogação)", async () => {
  const seed = baseSeed();
  seed.Participant.push({
    id: "part_cancel", event_id: EVENT_A, person_id: "p1", email: "spk@x.com",
    role_in_event: "attendee", registration_status: "cancelled", is_deleted: false,
  });
  const svc = makeSvc(seed);
  const identity = await resolveIdentity(svc, { id: "u1", email: "spk@x.com" });
  const mine = await findMyParticipants(svc, identity, EVENT_A);
  assert.ok(!mine.some((p) => p.id === "part_cancel"), "participante cancelado não pode constar como vínculo ativo");
  assert.ok(mine.some((p) => p.id === "part_speaker_A"), "o vínculo não cancelado permanece");
});

test("11 — participação soft-deleted não autoriza acesso", async () => {
  const seed = baseSeed();
  seed.Participant.push({
    id: "part_del", event_id: EVENT_A, person_id: "p1", email: "spk@x.com",
    role_in_event: "attendee", registration_status: "confirmed", is_deleted: true,
  });
  const svc = makeSvc(seed);
  const identity = await resolveIdentity(svc, { id: "u1", email: "spk@x.com" });
  const mine = await findMyParticipants(svc, identity, EVENT_A);
  assert.ok(!mine.some((p) => p.id === "part_del"));
});

test("12 — participante de OUTRA pessoa nunca entra no conjunto do chamador", async () => {
  const svc = makeSvc(baseSeed());
  const identity = await resolveIdentity(svc, { id: "u1", email: "spk@x.com" });
  const mine = await findMyParticipants(svc, identity, EVENT_A);
  assert.ok(!mine.some((p) => p.id === "part_speaker_B"));
});

test("13 — participante do MESMO e-mail em OUTRO evento não autoriza o evento alheio", async () => {
  const seed = baseSeed();
  seed.Participant.push({
    id: "part_other_event", event_id: EVENT_B, person_id: "p1", email: "spk@x.com",
    role_in_event: "attendee", registration_status: "confirmed", is_deleted: false,
  });
  const svc = makeSvc(seed);
  const identity = await resolveIdentity(svc, { id: "u1", email: "spk@x.com" });
  const mineInB = await findMyParticipants(svc, identity, EVENT_B);
  // O vínculo é do próprio usuário, mas a consulta é escopada por evento:
  // o conjunto nunca mistura eventos diferentes.
  assert.ok(mineInB.every((p) => p.event_id === EVENT_B));
});