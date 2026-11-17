// F3-10 / F3-11 (2026-11-12) — TESTES DE CAMINHO HTTP das funções de auditoria.
//
// Diferente dos testes de módulo compartilhado, aqui a FUNÇÃO BACKEND é chamada
// de ponta a ponta: `entry.ts` recebe a requisição, aplica o guard de conta,
// confere autorização por evento, grava no banco (falso) e devolve a resposta
// HTTP. O SDK `npm:@base44/sdk` é substituído por um cliente falso injetado
// (tests/unit/lib/base44-sdk-stub.mjs) — sem rede e sem dados reais.
//
// Cobre:
//   • issueCertificate — trilha na emissão E recuperação na REEMISSÃO (o defeito
//     original retornava `alreadyExisted` antes de auditar).
//   • manageParticipant — role_change com trilha OBRIGATÓRIA (antes best-effort).
import test from "node:test";
import assert from "node:assert/strict";
import issueCertificate from "../../base44/functions/issueCertificate/entry.ts";
import manageParticipant from "../../base44/functions/manageParticipant/entry.ts";

const EVENT = "evt_a";
const OTHER_EVENT = "evt_b";

function matches(row, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$in" in expected) return expected.$in.includes(row[key]);
      if ("$ne" in expected) return row[key] !== expected.$ne;
      return false;
    }
    return row[key] === expected;
  });
}

function fixture() {
  const state = {
    seq: 0,
    faults: { mainAudit: false, anyAudit: false, auditRead: false, evidenceWrite: false },
    users: [{
      id: "user_1",
      full_name: "Gerente Teste",
      email: "gerente@teste.dev",
      role: "user",
      account_status: "active",
    }, {
      id: "user_2",
      full_name: "Revisor Teste",
      email: "rev@teste.dev",
      role: "user",
      account_status: "active",
      person_id: "person_2",
    }],
    memberships: [{
      id: "mem_1", event_id: EVENT, user_id: "user_1",
      role: "manager", is_active: true, is_deleted: false,
    }, {
      id: "mem_rev", event_id: EVENT, person_id: "person_2", user_id: "user_2",
      user_email: "rev@teste.dev", role: "reviewer",
      is_active: false, is_deleted: true, updated_date: "2026-01-01T00:00:30.000Z",
    }, {
      id: "mem_rev2", event_id: EVENT, person_id: "person_2", user_id: "user_2",
      user_email: "rev@teste.dev", role: "reviewer",
      is_active: true, is_deleted: false, updated_date: "2026-01-01T00:00:31.000Z",
    }, {
      // Estado contraditório: ativo e excluído ao mesmo tempo.
      id: "mem_bad", event_id: EVENT, person_id: "person_2", role: "reviewer",
      is_active: true, is_deleted: true,
    }, {
      // Vínculo de avaliador de OUTRO evento.
      id: "mem_other", event_id: OTHER_EVENT, person_id: "person_2", role: "reviewer",
      is_active: false, is_deleted: true,
    }],
    participants: [
      { id: "part_1", event_id: EVENT, person_id: "person_1", full_name: "Fulano", email: "fulano@teste.dev", role_in_event: "attendee", is_deleted: false, updated_date: "2026-01-01T00:00:00.000Z" },
      { id: "part_2", event_id: OTHER_EVENT, person_id: "person_3", full_name: "Outro", email: "outro@teste.dev", role_in_event: "attendee", is_deleted: false, updated_date: "2026-01-01T00:00:00.000Z" },
    ],
    sessions: [],
    certificates: [],
    audits: [],
    evidence: [],
    events: [
      { id: EVENT, name: "Evento A", is_deleted: false, status: "active" },
      { id: OTHER_EVENT, name: "Evento B", is_deleted: false, status: "active" },
    ],
    persons: [
      { id: "person_1", full_name: "Fulano", contact_email: "fulano@teste.dev", is_active: true },
      { id: "person_2", full_name: "Revisor Teste", contact_email: "rev@teste.dev", is_active: true },
      { id: "person_3", full_name: "Outro", contact_email: "outro@teste.dev", is_active: true },
    ],
    invites: [],
    awardConfigs: [],
  };
  return { state };
}

function nextStamp(state) {
  state.seq += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, state.seq)).toISOString();
}

function entity(name, rows, state) {
  return {
    filter: async (query = {}) => {
      if (name === "AuditLog" && state.faults.auditRead) throw new Error("leitura de auditoria indisponível");
      return rows.filter((row) => matches(row, query)).map((row) => ({ ...row }));
    },
    get: async (id) => {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    create: async (data = {}) => {
      if (name === "AccessChangeEvidence" && state.faults.evidenceWrite) {
        throw new Error("evidência indisponível");
      }
      if (name === "AuditLog") {
        const isPending = String(data.audit_key || "").endsWith("|pending");
        if (state.faults.anyAudit) throw new Error("AuditLog indisponível");
        if (state.faults.mainAudit && !isPending) throw new Error("AuditLog indisponível (principal)");
      }
      const row = { id: `${name}_${rows.length + 1}`, created_date: nextStamp(state), is_deleted: false, ...data };
      rows.push(row);
      return { ...row };
    },
    update: async (id, data = {}) => {
      const index = rows.findIndex((r) => r.id === id);
      if (index < 0) throw new Error("registro não encontrado");
      rows[index] = { ...rows[index], ...data, updated_date: nextStamp(state) };
      return { ...rows[index] };
    },
    delete: async (id) => {
      const index = rows.findIndex((r) => r.id === id);
      if (index >= 0) rows.splice(index, 1);
      return { ok: true };
    },
    bulkUpdate: async (items = []) => {
      for (const item of items) {
        const index = rows.findIndex((r) => r.id === item.id);
        if (index >= 0) rows[index] = { ...rows[index], ...item, updated_date: nextStamp(state) };
      }
      return { ok: true };
    },
  };
}

function makeClient(state) {
  const entities = {
    User: entity("User", state.users, state),
    EventMembership: entity("EventMembership", state.memberships, state),
    Participant: entity("Participant", state.participants, state),
    Session: entity("Session", state.sessions, state),
    Certificate: entity("Certificate", state.certificates, state),
    AuditLog: entity("AuditLog", state.audits, state),
    AccessChangeEvidence: entity("AccessChangeEvidence", state.evidence, state),
    Event: entity("Event", state.events, state),
    Person: entity("Person", state.persons, state),
    EventInvite: entity("EventInvite", state.invites, state),
    AwardConfig: entity("AwardConfig", state.awardConfigs, state),
  };
  return {
    auth: { me: async () => ({ ...state.users[0] }) },
    asServiceRole: { entities },
  };
}

async function invoke(state, fn, body) {
  globalThis.__base44ClientFromRequest = () => makeClient(state);
  const res = await fn({ json: async () => body, headers: new Headers() });
  return { status: res.status, data: await res.json() };
}

function certBody(overrides = {}) {
  return { eventId: EVENT, participantId: "part_1", tipo: "participante", ...overrides };
}

function certAudits(state) {
  return state.audits.filter((a) => String(a.audit_key || "").startsWith("certificado_emitido|"));
}

// ---------------------------------------------------------------------------
// issueCertificate — emissão
// ---------------------------------------------------------------------------
test("HTTP-1 — emissão nova com trilha gravada", async () => {
  const f = fixture();
  const res = await invoke(f.state, issueCertificate, certBody());

  assert.equal(res.status, 200);
  assert.equal(res.data.alreadyExisted, false);
  assert.equal(res.data.audit_state, "recorded");
  assert.equal(f.state.certificates.length, 1);
  assert.equal(certAudits(f.state).length, 1);
  assert.equal(f.state.audits[0].mandatory, true);
});

test("HTTP-2 — trilha principal falha e a pendência é persistida", async () => {
  const f = fixture();
  f.state.faults.mainAudit = true;
  const res = await invoke(f.state, issueCertificate, certBody());

  assert.equal(res.status, 200);
  assert.equal(res.data.audit_state, "pending");
  const pending = f.state.audits.filter((a) => a.status === "pending");
  assert.equal(pending.length, 1, "uma pendência confirmada por leitura");
});

test("HTTP-3 — principal e pendência falham: resposta explícita, sem trilha falsa", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  const res = await invoke(f.state, issueCertificate, certBody());

  assert.equal(res.status, 503);
  assert.equal(res.data.audit_state, "unavailable");
  assert.ok(res.data.certificate, "o certificado existe e é devolvido");
  assert.equal(f.state.audits.length, 0, "nada é declarado auditado");
});

// ---------------------------------------------------------------------------
// issueCertificate — reemissão (o defeito corrigido)
// ---------------------------------------------------------------------------
test("HTTP-4 — reemissão após falha total RECUPERA a trilha", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  const first = await invoke(f.state, issueCertificate, certBody());
  assert.equal(first.status, 503);

  f.state.faults.anyAudit = false;
  const retry = await invoke(f.state, issueCertificate, certBody());

  assert.equal(retry.status, 200);
  assert.equal(retry.data.alreadyExisted, true);
  assert.equal(retry.data.audit_state, "recorded");
  assert.equal(retry.data.audit_recovered, true, "a trilha ausente foi gravada na reemissão");
  assert.equal(f.state.certificates.length, 1, "nenhum certificado duplicado");
  assert.equal(certAudits(f.state).length, 1);
  assert.equal(certAudits(f.state)[0].audit_key, `certificado_emitido|${first.data.certificate.id}`);
});

test("HTTP-5 — reemissão com pendência existente não cria outra pendência", async () => {
  const f = fixture();
  f.state.faults.mainAudit = true;
  await invoke(f.state, issueCertificate, certBody());
  assert.equal(f.state.audits.filter((a) => a.status === "pending").length, 1);

  f.state.faults.mainAudit = false;
  const retry = await invoke(f.state, issueCertificate, certBody());

  assert.equal(retry.status, 200);
  assert.equal(retry.data.audit_state, "recorded");
  assert.equal(f.state.audits.filter((a) => a.status === "pending").length, 1, "pendência única");
});

test("HTTP-6 — reemissão com trilha já gravada não duplica registro", async () => {
  const f = fixture();
  await invoke(f.state, issueCertificate, certBody());
  const retry = await invoke(f.state, issueCertificate, certBody());

  assert.equal(retry.status, 200);
  assert.equal(retry.data.alreadyExisted, true);
  assert.equal(retry.data.audit_recovered, false, "apenas confirmou a trilha existente");
  assert.equal(certAudits(f.state).length, 1);
});

test("HTTP-7 — leitura de auditoria indisponível: falha explícita, nunca aprovação", async () => {
  const f = fixture();
  f.state.faults.auditRead = true;
  const res = await invoke(f.state, issueCertificate, certBody());

  assert.equal(res.status, 503);
  assert.equal(res.data.audit_state, "unavailable");
});

test("HTTP-10 — certificado legado sem trilha é recuperado na reemissão", async () => {
  const f = fixture();
  f.state.certificates.push({
    id: "cert_legado",
    event_id: EVENT,
    participant_id: "part_1",
    tipo: "participante",
    template: "classico",
    hash_code: "ABCD-1234",
    is_deleted: false,
    created_date: "2025-01-01T00:00:00.000Z",
  });

  const res = await invoke(f.state, issueCertificate, certBody());

  assert.equal(res.status, 200);
  assert.equal(res.data.alreadyExisted, true);
  assert.equal(res.data.audit_recovered, true);
  assert.equal(certAudits(f.state).length, 1);
  assert.equal(f.state.certificates.length, 1, "não emite novo certificado");
});

test("HTTP-AUTH — gerente de outro evento não emite certificado", async () => {
  const f = fixture();
  const res = await invoke(f.state, issueCertificate, certBody({ eventId: OTHER_EVENT, participantId: "part_2" }));

  assert.equal(res.status, 403);
  assert.equal(f.state.certificates.length, 0);
  assert.equal(f.state.audits.length, 0);
});

// ---------------------------------------------------------------------------
// manageParticipant — role_change com trilha obrigatória
// ---------------------------------------------------------------------------
function roleBody(overrides = {}) {
  return { op: "update", event_id: EVENT, participant_id: "part_1", data: { role_in_event: "speaker" }, ...overrides };
}

function roleAudits(state) {
  return state.audits.filter((a) => a.action === "role_change");
}

test("HTTP-20 — alteração de papel com trilha gravada", async () => {
  const f = fixture();
  const res = await invoke(f.state, manageParticipant, roleBody());

  assert.equal(res.status, 200);
  assert.equal(res.data.audit_state, "recorded");
  assert.equal(roleAudits(f.state).length, 1);
  const trail = roleAudits(f.state)[0];
  assert.equal(trail.mandatory, true);
  assert.equal(trail.user_id, "user_1");
  assert.equal(trail.event_id, EVENT);
  assert.equal(trail.entity_id, "part_1");
  assert.equal(JSON.parse(trail.details).new_value, "speaker");
});

test("HTTP-21 — trilha principal falha: pendência persistida e operação sinalizada", async () => {
  const f = fixture();
  f.state.faults.mainAudit = true;
  const res = await invoke(f.state, manageParticipant, roleBody());

  assert.equal(res.status, 200);
  assert.equal(res.data.audit_state, "pending");
  assert.equal(f.state.audits.filter((a) => a.status === "pending").length, 1);
});

test("HTTP-22 — principal e pendência falham: 503, nunca sucesso silencioso", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  const res = await invoke(f.state, manageParticipant, roleBody());

  assert.equal(res.status, 503);
  assert.equal(res.data.audit_state, "unavailable");
  assert.equal(f.state.audits.length, 0);
  // Estado real documentado: a escrita ocorreu e permanece sem trilha.
  assert.equal(f.state.participants.find((p) => p.id === "part_1").role_in_event, "speaker");
});

test("HTTP-23 — repetir o mesmo papel não cria trilha falsa", async () => {
  const f = fixture();
  await invoke(f.state, manageParticipant, roleBody());
  const before = roleAudits(f.state).length;

  const again = await invoke(f.state, manageParticipant, roleBody());

  assert.equal(again.status, 200);
  assert.equal(roleAudits(f.state).length, before, "nenhuma trilha nova para alteração inexistente");
});

test("HTTP-24 — duas transições legítimas geram trilhas distintas", async () => {
  const f = fixture();
  await invoke(f.state, manageParticipant, roleBody());
  await invoke(f.state, manageParticipant, roleBody({ data: { role_in_event: "attendee" } }));

  const keys = roleAudits(f.state).map((a) => a.audit_key);
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 2, "chaves determinísticas distintas por ocorrência");
});

test("HTTP-25 — corpo não falsifica autor nem evento da trilha", async () => {
  const f = fixture();
  const res = await invoke(f.state, manageParticipant, roleBody({
    user_id: "atacante",
    user_name: "Atacante",
    actor: "atacante",
    event_id: EVENT,
    data: { role_in_event: "speaker", user_id: "atacante", event_id: OTHER_EVENT },
  }));

  assert.equal(res.status, 200);
  const trail = roleAudits(f.state)[0];
  assert.equal(trail.user_id, "user_1", "autor vem do contexto autenticado");
  assert.equal(trail.event_id, EVENT, "evento vem do gate, não do corpo");
});

test("HTTP-26 — sem vínculo no evento a alteração é negada e nada é auditado", async () => {
  const f = fixture();
  const res = await invoke(f.state, manageParticipant, roleBody({ event_id: OTHER_EVENT, participant_id: "part_2" }));

  assert.equal(res.status, 403);
  assert.equal(f.state.audits.length, 0);
  assert.equal(f.state.participants.find((p) => p.id === "part_2").role_in_event, "attendee");
});

// ---------------------------------------------------------------------------
// manageParticipant — RECUPERAÇÃO ancorada em EVIDÊNCIA DURÁVEL (F3-14)
//
// A recuperação só existe se houver evidência gravada ANTES da mutação. Papel
// atual e `updated_date` isolados NÃO autorizam trilha nenhuma.
// ---------------------------------------------------------------------------
function recoverBody(overrides = {}) {
  return { op: "recoverRoleAudit", event_id: EVENT, participant_id: "part_1", ...overrides };
}

function setReviewerBody(overrides = {}) {
  return { op: "setReviewer", event_id: EVENT, enable: true, person_id: "person_1", ...overrides };
}

function evidenceOf(state, participantId = "part_1") {
  return state.evidence.find((e) => e.entity_id === participantId);
}

function seedEvidence(state, overrides = {}) {
  const row = {
    id: `ev_${state.evidence.length + 1}`,
    event_id: EVENT,
    entity_type: "Participant",
    entity_id: "part_1",
    operation: "role_change",
    occurrence: "participant:part_1:seed",
    old_value: "attendee",
    new_value: "speaker",
    actor_user_id: "user_1",
    actor_name: "Gerente Teste",
    audit_key: "role_change|participant:part_1:seed",
    state: "applied",
    is_deleted: false,
    created_date: "2026-01-01T00:00:10.000Z",
    ...overrides,
  };
  state.evidence.push(row);
  return row;
}

test("HTTP-27 — alteração real com trilha pendente: recuperação conclui com o ATOR ORIGINAL", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  const failed = await invoke(f.state, manageParticipant, roleBody());

  assert.equal(failed.status, 503);
  assert.equal(failed.data.applied, true);
  assert.ok(failed.data.recovery?.evidence_id, "a resposta devolve a evidência preservada");
  assert.equal(roleAudits(f.state).length, 0);

  // Evidência durável: evento, participante, ocorrência, papéis e ator original.
  const ev = evidenceOf(f.state);
  assert.equal(ev.event_id, EVENT);
  assert.equal(ev.entity_id, "part_1");
  assert.equal(ev.old_value, "attendee");
  assert.equal(ev.new_value, "speaker");
  assert.equal(ev.actor_user_id, "user_1");
  assert.equal(ev.state, "audit_unavailable");

  f.state.faults.anyAudit = false;
  const recovered = await invoke(f.state, manageParticipant, recoverBody({ evidence_id: failed.data.recovery.evidence_id }));

  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.audit_state, "recorded");
  assert.equal(recovered.data.recovered, true);
  assert.equal(recovered.data.original_actor_known, true);

  const trails = roleAudits(f.state);
  assert.equal(trails.length, 1);
  assert.equal(trails[0].user_id, "user_1", "autoria ORIGINAL vem da evidência");
  assert.equal(trails[0].event_id, EVENT);
  const details = JSON.parse(trails[0].details);
  assert.equal(details.recovered, true);
  assert.equal(details.recovery_source, "evidencia_persistida");
  assert.equal(details.old_value, "attendee", "papel anterior vem da evidência");
  assert.equal(details.new_value, "speaker");
  assert.equal(details.evidence_id, ev.id);
  assert.equal(evidenceOf(f.state).state, "audit_recorded");
});

test("HTTP-28 — retry após recuperação bem-sucedida não duplica a trilha", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  await invoke(f.state, manageParticipant, roleBody());
  f.state.faults.anyAudit = false;

  const first = await invoke(f.state, manageParticipant, recoverBody());
  const second = await invoke(f.state, manageParticipant, recoverBody());

  assert.equal(first.data.recovered, true);
  assert.equal(second.status, 200);
  assert.equal(second.data.already_recorded, true);
  assert.equal(second.data.recovered, false);
  assert.equal(roleAudits(f.state).length, 1);
});

test("HTTP-29 — falha de persistência na recuperação: segura, nada inventado, repetível", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  await invoke(f.state, manageParticipant, roleBody());

  const blocked = await invoke(f.state, manageParticipant, recoverBody());

  assert.equal(blocked.status, 503);
  assert.equal(blocked.data.audit_state, "unavailable");
  assert.equal(blocked.data.recovered, false);
  assert.equal(f.state.audits.length, 0, "nenhuma trilha declarada sem gravação");
  assert.equal(evidenceOf(f.state).state, "audit_unavailable", "evidência preservada para nova tentativa");

  f.state.faults.anyAudit = false;
  const retry = await invoke(f.state, manageParticipant, recoverBody());

  assert.equal(retry.status, 200);
  assert.equal(retry.data.recovered, true);
  assert.equal(roleAudits(f.state).length, 1);
});

test("HTTP-30 — corpo adulterado não é autoridade e evento diferente é negado", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  await invoke(f.state, manageParticipant, roleBody());
  f.state.faults.anyAudit = false;

  const tampered = await invoke(f.state, manageParticipant, recoverBody({
    role_in_event: "manager",
    old_value: "attendee",
    new_value: "manager",
    user_id: "atacante",
    actor_name: "Atacante",
    entity_type: "Participant",
  }));

  assert.equal(tampered.status, 200);
  const trail = roleAudits(f.state)[0];
  assert.equal(trail.user_id, "user_1", "autor do corpo é ignorado");
  assert.equal(JSON.parse(trail.details).new_value, "speaker", "papel do corpo é ignorado");

  const crossEvent = await invoke(f.state, manageParticipant, recoverBody({ event_id: OTHER_EVENT }));
  assert.equal(crossEvent.status, 403, "gate do evento bloqueia antes de qualquer trilha");
  assert.equal(roleAudits(f.state).length, 1);
});

test("HTTP-31 — duas recuperações simultâneas produzem UMA única trilha", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  await invoke(f.state, manageParticipant, roleBody());
  f.state.faults.anyAudit = false;

  const [a, b] = await Promise.all([
    invoke(f.state, manageParticipant, recoverBody()),
    invoke(f.state, manageParticipant, recoverBody()),
  ]);

  assert.ok([a.status, b.status].every((s) => s === 200), "as duas respostas são coerentes");
  const trails = roleAudits(f.state);
  assert.equal(trails.length, 1, "uma única trilha apesar da concorrência");
});

test("HTTP-32 — participante sem alteração de papel: recuperação NEGADA, nada é criado", async () => {
  const f = fixture();
  const res = await invoke(f.state, manageParticipant, recoverBody());

  assert.equal(res.status, 409);
  assert.equal(res.data.recovered, false);
  assert.match(res.data.error, /evidência/i);
  assert.equal(f.state.audits.length, 0, "nenhuma trilha fictícia");
  assert.equal(f.state.evidence.length, 0);
});

test("HTTP-33 — estado persistido incompatível com a evidência é recusado", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  await invoke(f.state, manageParticipant, roleBody());
  f.state.faults.anyAudit = false;

  // Papel alterado por fora depois da operação (não corresponde à evidência).
  await invoke(f.state, manageParticipant, {
    op: "update", event_id: EVENT, participant_id: "part_1", data: { role_in_event: "attendee" },
  });
  f.state.audits.length = 0;

  const res = await invoke(f.state, manageParticipant, recoverBody());

  assert.equal(res.status, 409);
  assert.equal(res.data.recovered, false);
  assert.equal(f.state.audits.length, 0);
});

test("HTTP-34 — autor original desconhecido: sistema, nunca o operador da recuperação", async () => {
  const f = fixture();
  f.state.participants[0].role_in_event = "speaker";
  seedEvidence(f.state, { actor_user_id: "", actor_name: "" });

  const res = await invoke(f.state, manageParticipant, recoverBody());

  assert.equal(res.status, 200);
  assert.equal(res.data.original_actor_known, false);
  const trail = roleAudits(f.state)[0];
  assert.equal(trail.user_id, "system", "autoria não é atribuída a quem recuperou");
  assert.equal(trail.user_name, "Autor original desconhecido");
  const details = JSON.parse(trail.details);
  assert.equal(details.original_actor_known, false);
  assert.equal(details.recovered_by_user_id, "user_1", "operador da recuperação é registrado como tal");
});

test("HTTP-35 — evidência de operação NÃO aplicada não gera trilha", async () => {
  const f = fixture();
  f.state.participants[0].role_in_event = "speaker";
  seedEvidence(f.state, { state: "started" });

  const res = await invoke(f.state, manageParticipant, recoverBody());

  assert.equal(res.status, 409);
  assert.match(res.data.error, /não foi concluída/i);
  assert.equal(f.state.audits.length, 0);
});

test("HTTP-36 — sem evidência durável a alteração NÃO é aplicada (fail-closed)", async () => {
  const f = fixture();
  f.state.faults.evidenceWrite = true;

  const res = await invoke(f.state, manageParticipant, roleBody());

  assert.equal(res.status, 503);
  assert.equal(res.data.applied, false);
  assert.equal(f.state.participants.find((p) => p.id === "part_1").role_in_event, "attendee", "nada é alterado");
  assert.equal(f.state.audits.length, 0);
});

test("HTTP-37 — evidência de outro participante não é aceita como seleção", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  await invoke(f.state, manageParticipant, roleBody());
  f.state.faults.anyAudit = false;
  const ownEvidence = evidenceOf(f.state);

  seedEvidence(f.state, {
    id: "ev_alheia",
    entity_id: "part_3",
    new_value: "attendee",
  });

  const res = await invoke(f.state, manageParticipant, recoverBody({ evidence_id: "ev_alheia" }));

  assert.equal(res.status, 409);
  assert.match(res.data.error, /não pertence/i);
  assert.equal(f.state.audits.length, 0);
  assert.equal(ownEvidence.state, "audit_unavailable", "a evidência legítima permanece intacta");
});

// ---------------------------------------------------------------------------
// manageParticipant.setReviewer — REATIVAÇÃO auditada pelo mecanismo central
// ---------------------------------------------------------------------------

function accessAudits(state, prefix) {
  return state.audits.filter((a) => String(a.audit_key || "").startsWith(prefix));
}

test("SR-1 — reativação de vínculo existente gera trilha obrigatória", async () => {
  const f = fixture();
  const res = await invoke(f.state, manageParticipant, {
    ...setReviewerBody({ membership_id: "mem_rev" }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.audit_state, "recorded");
  assert.equal(res.data.already_active, false);

  const membership = f.state.memberships.find((m) => m.id === "mem_rev");
  assert.equal(membership.is_active, true);
  assert.equal(membership.is_deleted, false);
  assert.equal(membership.user_id, "user_2", "titular vem do vínculo, não do corpo");

  const trails = accessAudits(f.state, "reviewer_reactivation|");
  assert.equal(trails.length, 1);
  assert.equal(trails[0].action, "role_change");
  assert.equal(trails[0].entity_type, "EventMembership");
  assert.equal(trails[0].entity_id, "mem_rev");
  assert.equal(trails[0].event_id, EVENT);
  assert.equal(trails[0].user_id, "user_1", "ator responsável vem do contexto autenticado");
  assert.equal(trails[0].mandatory, true);
  const details = JSON.parse(trails[0].details);
  assert.equal(details.role, "reviewer");
  assert.equal(details.outcome, "reactivated");
  assert.equal(details.reviewer_user_id, "user_2");
});

test("SR-2 — reativação repetida não duplica a trilha", async () => {
  const f = fixture();
  await invoke(f.state, manageParticipant, setReviewerBody({ membership_id: "mem_rev" }));
  const again = await invoke(f.state, manageParticipant, setReviewerBody({ membership_id: "mem_rev" }));

  assert.equal(again.status, 200);
  assert.equal(again.data.already_active, true);
  assert.equal(again.data.audit_state, "recorded");
  assert.equal(accessAudits(f.state, "reviewer_reactivation|").length, 1);
});

test("SR-3 — auditoria indisponível: estado explícito e retry recupera sem duplicar", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  const blocked = await invoke(f.state, manageParticipant, setReviewerBody({ membership_id: "mem_rev" }));

  assert.equal(blocked.status, 503);
  assert.equal(blocked.data.audit_state, "unavailable");
  assert.equal(accessAudits(f.state, "reviewer_reactivation|").length, 0);
  assert.equal(f.state.memberships.find((m) => m.id === "mem_rev").is_active, true);

  f.state.faults.anyAudit = false;
  const retry = await invoke(f.state, manageParticipant, setReviewerBody({ membership_id: "mem_rev" }));

  assert.equal(retry.status, 200);
  assert.equal(retry.data.audit_state, "recorded");
  assert.equal(accessAudits(f.state, "reviewer_reactivation|").length, 1);
});

test("SR-4 — vínculo de outro evento é negado e nada muda", async () => {
  const f = fixture();
  const res = await invoke(f.state, manageParticipant, setReviewerBody({ membership_id: "mem_other" }));

  assert.equal(res.status, 404);
  assert.equal(accessAudits(f.state, "reviewer_reactivation|").length, 0);
  assert.equal(f.state.memberships.find((m) => m.id === "mem_other").is_active, false);
});

test("SR-5 — vínculo inexistente e estado contraditório são negados", async () => {
  const f = fixture();
  const missing = await invoke(f.state, manageParticipant, setReviewerBody({ membership_id: "mem_x" }));
  assert.equal(missing.status, 404);

  const invalid = await invoke(f.state, manageParticipant, setReviewerBody({ membership_id: "mem_bad" }));
  assert.equal(invalid.status, 409);
  assert.equal(accessAudits(f.state, "reviewer_reactivation|").length, 0);
});

test("SR-6 — concessão e revogação de avaliador devolvem trilha consistente", async () => {
  const f = fixture();

  const revoked = await invoke(f.state, manageParticipant, {
    op: "setReviewer", event_id: EVENT, enable: false, membership_id: "mem_rev2", person_id: "person_2",
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.data.audit_state, "recorded");
  assert.equal(accessAudits(f.state, "role_revoke|").length, 1);
  assert.equal(f.state.memberships.find((m) => m.id === "mem_rev2").is_active, false);

  const granted = await invoke(f.state, manageParticipant, {
    op: "setReviewer", event_id: EVENT, enable: true, person_id: "person_2", user_email: "rev@teste.dev",
  });
  assert.equal(granted.status, 200);
  assert.equal(granted.data.audit_state, "recorded");
  assert.equal(accessAudits(f.state, "role_grant|").length, 1);
});