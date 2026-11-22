// P1-04 (AUD-03) — primitiva ÚNICA de alteração de papel.
//
// Exercita o ciclo completo (gate → evidência → claim CAS → confirmação por
// leitura → trilha obrigatória → liberação) e as falhas em cada ponto, além da
// concorrência entre duas alterações do mesmo participante.

import test from "node:test";
import assert from "node:assert/strict";

import { buildAuditKey } from "../../base44/shared/auditTrail.ts";
import {
  applyParticipantRole,
  createParticipantWithRole,
  ROLE_TOKEN_FIELD,
  ROLE_LOCK_FIELD,
  ROLE_PENDING_FIELD,
} from "../../base44/shared/roleChange.ts";

function matchesValue(actual, cond) {
  if (cond === undefined) return true;
  if (Array.isArray(cond)) return cond.includes(actual);
  if (cond && typeof cond === "object") {
    if ("$in" in cond) return cond.$in.includes(actual);
    if ("$ne" in cond) return actual !== cond.$ne;
    return false;
  }
  return actual === cond;
}

function matches(doc, query = {}) {
  return Object.entries(query).every(([k, v]) => matchesValue(doc[k], v));
}

function applyUpdate(doc, update) {
  for (const [op, payload] of Object.entries(update)) {
    if (op === "$set") Object.assign(doc, payload);
    else if (op === "$inc") for (const [k, v] of Object.entries(payload)) doc[k] = (Number(doc[k]) || 0) + v;
    else if (op === "$addToSet") {
      for (const [k, v] of Object.entries(payload)) {
        if (!Array.isArray(doc[k])) doc[k] = [];
        if (!doc[k].includes(v)) doc[k].push(v);
      }
    } else throw new Error(`operador não suportado: ${op}`);
  }
}

function collection(rows, opts = {}) {
  return {
    async filter(query = {}) {
      if (opts.failFilter) throw new Error("leitura indisponível");
      return rows.filter((d) => matches(d, query)).map((d) => ({ ...d }));
    },
    async updateMany(query, update) {
      const targets = rows.filter((d) => matches(d, query));
      for (const d of targets) applyUpdate(d, update);
      return { updated: targets.length };
    },
    async update(id, patch) {
      const d = rows.find((x) => x.id === id);
      if (!d) return null;
      Object.assign(d, patch);
      return { ...d };
    },
    async create(data) {
      if (opts.failCreate) throw new Error("gravação indisponível");
      const row = { id: `gen_${rows.length + 1}_${Math.random().toString(36).slice(2, 6)}`, ...data };
      rows.push(row);
      return { ...row };
    },
    async delete(id) {
      const idx = rows.findIndex((x) => x.id === id);
      if (idx >= 0) rows.splice(idx, 1);
      return { ok: true };
    },
  };
}

function setup({ participant = {}, auditFail = false, evidenceFail = false } = {}) {
  const participants = [{
    id: "part_1",
    event_id: "ev_1",
    email: "pessoa@example.com",
    role_in_event: "attendee",
    is_deleted: false,
    ...participant,
  }];
  const evidences = [];
  const audits = [];
  const svc = {
    entities: {
      Participant: collection(participants),
      AccessChangeEvidence: collection(evidences, { failCreate: evidenceFail }),
      AuditLog: collection(audits, { failCreate: auditFail }),
    },
  };
  return { svc, participants, evidences, audits };
}

const ACTOR = { id: "u_actor", full_name: "Gestor" };

test("P1-04 — alteração aplica papel, grava evidência e trilha e libera o claim", async () => {
  const { svc, participants, evidences, audits } = setup();
  const out = await applyParticipantRole(svc, {
    eventId: "ev_1",
    participantId: "part_1",
    newRole: "speaker",
    actor: ACTOR,
    source: "teste",
  });

  assert.equal(out.ok, true);
  assert.equal(out.audit_state, "recorded");
  assert.equal(out.role_change_blocked, false);
  assert.equal(participants[0].role_in_event, "speaker");
  assert.equal(participants[0][ROLE_PENDING_FIELD], "", "claim liberado com trilha confirmada");
  assert.equal(participants[0][ROLE_LOCK_FIELD], false);
  assert.equal(evidences.length, 1);
  assert.equal(evidences[0].state, "audit_recorded");
  assert.equal(evidences[0].entity_id, "part_1");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].entity_id, "part_1");
  assert.match(audits[0].details, /"new_value":"speaker"/);
});

test("P1-04 — papel igual não cria evidência (apenas salva os demais campos)", async () => {
  const { svc, participants, evidences, audits } = setup();
  const out = await applyParticipantRole(svc, {
    eventId: "ev_1",
    participantId: "part_1",
    newRole: "attendee",
    data: { company: "ACME" },
    actor: ACTOR,
    source: "teste",
  });

  assert.equal(out.ok, true);
  assert.equal(out.unchanged, true);
  assert.equal(participants[0].company, "ACME");
  assert.equal(evidences.length, 0);
  assert.equal(audits.length, 0);
});

test("P1-04 — falha na evidência bloqueia a mutação (fail-closed)", async () => {
  const { svc, participants, evidences } = setup({ evidenceFail: true });
  const out = await applyParticipantRole(svc, {
    eventId: "ev_1",
    participantId: "part_1",
    newRole: "manager",
    actor: ACTOR,
    source: "teste",
  });

  assert.equal(out.ok, false);
  assert.equal(out.status, 503);
  assert.equal(out.applied, false);
  assert.equal(participants[0].role_in_event, "attendee", "papel NÃO muda sem evidência");
  assert.equal(evidences.length, 0);
});

test("P1-04 — falha da trilha mantém o bloqueio e preserva a evidência", async () => {
  const { svc, participants, evidences } = setup({ auditFail: true });
  const out = await applyParticipantRole(svc, {
    eventId: "ev_1",
    participantId: "part_1",
    newRole: "speaker",
    actor: ACTOR,
    source: "teste",
  });

  assert.equal(out.ok, false);
  assert.equal(out.status, 503);
  assert.equal(out.applied, true, "a mutação aconteceu");
  assert.equal(out.audit_state, "unavailable");
  assert.equal(participants[0].role_in_event, "speaker");
  assert.notEqual(participants[0][ROLE_PENDING_FIELD], "", "pendência mantém a porta fechada");
  assert.equal(evidences.length, 1);
  assert.equal(evidences[0].state, "audit_unavailable");
});

test("P1-04 — porta bloqueia nova alteração com pendência sem trilha", async () => {
  const { svc, participants, evidences } = setup({
    participant: { [ROLE_PENDING_FIELD]: "occ_pendente" },
  });
  const out = await applyParticipantRole(svc, {
    eventId: "ev_1",
    participantId: "part_1",
    newRole: "speaker",
    actor: ACTOR,
    source: "teste",
  });

  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(out.pending_occurrence, "occ_pendente");
  assert.equal(participants[0].role_in_event, "attendee", "nada foi alterado");
  assert.equal(evidences.length, 0);
});

test("P1-04 — porta libera sozinha quando a trilha pendente é encontrada", async () => {
  const pending = "occ_resolvida";
  const { svc, participants, audits } = setup({
    participant: { [ROLE_PENDING_FIELD]: pending, [ROLE_LOCK_FIELD]: true },
  });
  audits.push({
    id: "audit_prev",
    audit_key: buildAuditKey("role_change", pending),
    entity_type: "Participant",
    entity_id: "part_1",
    created_date: "2026-01-01T00:00:00.000Z",
  });

  const out = await applyParticipantRole(svc, {
    eventId: "ev_1",
    participantId: "part_1",
    newRole: "speaker",
    actor: ACTOR,
    source: "teste",
  });

  assert.equal(out.ok, true, "a trilha encontrada libera a porta");
  assert.equal(participants[0].role_in_event, "speaker");
});

test("P1-04 — participante de outro evento não é alcançado", async () => {
  const { svc, participants } = setup();
  const out = await applyParticipantRole(svc, {
    eventId: "ev_OUTRO",
    participantId: "part_1",
    newRole: "manager",
    actor: ACTOR,
    source: "teste",
  });

  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal(participants[0].role_in_event, "attendee");
});

test("P1-04 — concorrência: A→B e B→C, exatamente um vence e o estado casa com a evidência", async () => {
  const { svc, participants, evidences, audits } = setup();
  const [first, second] = await Promise.all([
    applyParticipantRole(svc, {
      eventId: "ev_1", participantId: "part_1", newRole: "speaker", actor: ACTOR, source: "concorrente_1",
    }),
    applyParticipantRole(svc, {
      eventId: "ev_1", participantId: "part_1", newRole: "partner_rep", actor: ACTOR, source: "concorrente_2",
    }),
  ]);

  const winners = [first, second].filter((r) => r.ok);
  const losers = [first, second].filter((r) => !r.ok);
  assert.equal(winners.length, 1, "exatamente uma alteração é aplicada");
  assert.equal(losers.length, 1, "a outra é recusada (conflito ou porta bloqueada)");
  assert.ok([409, 503].includes(losers[0].status));

  const finalRole = participants[0].role_in_event;
  assert.ok(["speaker", "partner_rep"].includes(finalRole));

  // A evidência da ocorrência aplicada corresponde ao papel persistido.
  const appliedEvidence = evidences.find((e) => e.occurrence === participants[0][ROLE_TOKEN_FIELD]);
  assert.ok(appliedEvidence, "token do estado aponta para uma evidência existente");
  assert.equal(appliedEvidence.new_value, finalRole);
  assert.equal(evidences.length, 1, "a tentativa perdedora não deixa evidência recuperável");
  assert.ok(audits.length <= 1, "no máximo uma trilha para a única mutação");
});

test("P1-04 — criação com papel privilegiado grava evidência antes e audita", async () => {
  const { svc, participants, evidences, audits } = setup();
  const out = await createParticipantWithRole(svc, {
    eventId: "ev_1",
    data: { full_name: "Novo", email: "novo@example.com", role_in_event: "partner_rep" },
    actor: ACTOR,
    source: "teste_criacao",
  });

  assert.equal(participants.length, 2);
  assert.equal(participants[1].role_in_event, "partner_rep");
  assert.equal(participants[1][ROLE_PENDING_FIELD], "", "claim liberado");
  assert.equal(evidences.length, 1);
  assert.equal(evidences[0].old_value, null);
  assert.equal(evidences[0].new_value, "partner_rep");
  assert.equal(evidences[0].entity_id, participants[1].id);
  assert.equal(audits.length, 1);
  assert.equal(out.audit_state, "recorded");
});

test("P1-04 — criação com papel default não gera evidência", async () => {
  const { svc, participants, evidences, audits } = setup();
  await createParticipantWithRole(svc, {
    eventId: "ev_1",
    data: { full_name: "Participante", email: "p@example.com", role_in_event: "attendee" },
    actor: ACTOR,
    source: "teste_criacao",
  });

  assert.equal(participants.length, 2);
  assert.equal(evidences.length, 0);
  assert.equal(audits.length, 0);
});

test("P1-04 — criação privilegiada sem evidência NÃO cria participante", async () => {
  const { svc, participants } = setup({ evidenceFail: true });
  await assert.rejects(
    () => createParticipantWithRole(svc, {
      eventId: "ev_1",
      data: { full_name: "Novo", email: "novo@example.com", role_in_event: "speaker" },
      actor: ACTOR,
      source: "teste_criacao",
    }),
    /role_evidence_unavailable/,
  );
  assert.equal(participants.length, 1, "nada foi criado");
});