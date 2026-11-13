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
    faults: { mainAudit: false, anyAudit: false, auditRead: false },
    users: [{
      id: "user_1",
      full_name: "Gerente Teste",
      email: "gerente@teste.dev",
      role: "user",
      account_status: "active",
    }],
    memberships: [{
      id: "mem_1", event_id: EVENT, user_id: "user_1",
      role: "manager", is_active: true, is_deleted: false,
    }],
    participants: [
      { id: "part_1", event_id: EVENT, person_id: "person_1", full_name: "Fulano", email: "fulano@teste.dev", role_in_event: "attendee", is_deleted: false, updated_date: "2026-01-01T00:00:00.000Z" },
      { id: "part_2", event_id: OTHER_EVENT, person_id: "person_2", full_name: "Outro", email: "outro@teste.dev", role_in_event: "attendee", is_deleted: false, updated_date: "2026-01-01T00:00:00.000Z" },
    ],
    sessions: [],
    certificates: [],
    audits: [],
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