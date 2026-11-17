// F3-16 (2026-11-18) — TESTES HTTP da PORTA DE INTEGRIDADE do papel (P1-A) e do
// VÍNCULO reviewer ↔ conta ↔ Person (P1-B).
//
// Caminho HTTP real: `manageParticipant/entry.ts` recebe a requisição, aplica o
// guard de conta, o gate de evento, o claim condicional de documento único e a
// trilha obrigatória; o banco é falso e injeta falhas (AuditLog, evidência,
// escrita do participante). Nenhuma rede, nenhum dado real.
//
// Escopo deste arquivo (separado do fase3-http-audit.test.mjs para ficar
// editável e focado):
//   P1-A — nenhuma alteração de papel pode ficar sem trilha recuperável;
//   P1-B — a identidade do reviewer é provada por User.person_id, nunca por e-mail.
import test from "node:test";
import assert from "node:assert/strict";
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
    faults: {
      mainAudit: false,
      anyAudit: false,
      auditRead: false,
      auditReadShape: false,
      evidenceWrite: false,
      evidenceUpdate: false,
      evidenceQuery: false,
      participantWrite: false,
    },
    users: [
      // Gestor autenticado — vínculo User↔Person gravado no cadastro atômico.
      { id: "user_1", full_name: "Gerente Teste", email: "gerente@teste.dev", role: "user", account_status: "active", person_id: "person_1" },
      // Reviewer correto.
      { id: "user_2", full_name: "Revisor Teste", email: "rev@teste.dev", role: "user", account_status: "active", person_id: "person_2" },
      // E-mail IGUAL ao da person_4, mas vínculo aponta para outra pessoa.
      { id: "user_6", full_name: "Conta Alheia", email: "dup@teste.dev", role: "user", account_status: "active", person_id: "person_1" },
      // Conta legada: sem vínculo de pessoa confirmado.
      { id: "user_7", full_name: "Conta Legada", email: "legado@teste.dev", role: "user", account_status: "active" },
      // Vínculo correto com snapshot de e-mail desatualizado.
      { id: "user_8", full_name: "Revisor Teste", email: "rev.atual@teste.dev", role: "user", account_status: "active", person_id: "person_2" },
    ],
    memberships: [
      { id: "mem_1", event_id: EVENT, user_id: "user_1", role: "manager", is_active: true, is_deleted: false },
      { id: "mem_rev", event_id: EVENT, person_id: "person_2", user_id: "user_2", user_email: "rev@teste.dev", role: "reviewer", is_active: false, is_deleted: true, updated_date: "2026-01-01T00:00:30.000Z" },
      { id: "mem_email_coincident", event_id: EVENT, person_id: "person_4", role: "reviewer", is_active: false, is_deleted: true },
      { id: "mem_snapshot_stale", event_id: EVENT, person_id: "person_2", user_id: "user_8", user_email: "antigo@teste.dev", role: "reviewer", is_active: false, is_deleted: true },
      { id: "mem_legacy_account", event_id: EVENT, person_id: "person_2", user_id: "user_7", role: "reviewer", is_active: false, is_deleted: true },
      { id: "mem_other_event", event_id: OTHER_EVENT, person_id: "person_2", user_id: "user_2", role: "reviewer", is_active: false, is_deleted: true },
    ],
    participants: [
      { id: "part_1", event_id: EVENT, person_id: "person_1", full_name: "Fulano", email: "fulano@teste.dev", role_in_event: "attendee", is_deleted: false, updated_date: "2026-01-01T00:00:00.000Z" },
      { id: "part_3", event_id: EVENT, person_id: "person_3", full_name: "Terceiro", email: "terceiro@teste.dev", role_in_event: "attendee", is_deleted: false, updated_date: "2026-01-01T00:00:00.000Z" },
      { id: "part_2", event_id: OTHER_EVENT, person_id: "person_3", full_name: "Outro", email: "outro@teste.dev", role_in_event: "attendee", is_deleted: false, updated_date: "2026-01-01T00:00:00.000Z" },
    ],
    sessions: [],
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
      { id: "person_4", full_name: "Duplicada", contact_email: "dup@teste.dev", is_active: true },
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
      if (name === "AuditLog" && state.faults.auditReadShape) return { items: [], has_more: false };
      if (name === "AccessChangeEvidence" && state.faults.evidenceQuery) throw new Error("consulta de evidência indisponível");
      return rows.filter((row) => matches(row, query)).map((row) => ({ ...row }));
    },
    get: async (id) => {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    create: async (data = {}) => {
      if (name === "AccessChangeEvidence" && state.faults.evidenceWrite) throw new Error("evidência indisponível");
      if (name === "Participant" && state.faults.participantWrite) throw new Error("escrita de participante indisponível");
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
      if (name === "AccessChangeEvidence" && state.faults.evidenceUpdate) throw new Error("evidência indisponível");
      if (name === "Participant" && state.faults.participantWrite) throw new Error("escrita de participante indisponível");
      const index = rows.findIndex((r) => r.id === id);
      if (index < 0) throw new Error("registro não encontrado");
      rows[index] = { ...rows[index], ...data, updated_date: nextStamp(state) };
      return { ...rows[index] };
    },
    // CAS de documento único: só os registros que casam o filtro na hora da
    // escrita são atualizados — é o que garante um único vencedor em corrida.
    updateMany: async (query = {}, update = {}) => {
      if (name === "Participant" && state.faults.participantWrite) throw new Error("escrita de participante indisponível");
      const matched = rows.filter((row) => matches(row, query));
      const set = update.$set || {};
      for (const row of matched) Object.assign(row, set, { updated_date: nextStamp(state) });
      return { updated: matched.length };
    },
    bulkUpdate: async (items = []) => {
      for (const item of items) {
        const index = rows.findIndex((r) => r.id === item.id);
        if (index >= 0) rows[index] = { ...rows[index], ...item, updated_date: nextStamp(state) };
      }
      return { ok: true };
    },
    delete: async (id) => {
      const index = rows.findIndex((r) => r.id === id);
      if (index >= 0) rows.splice(index, 1);
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

async function invoke(state, body) {
  globalThis.__base44ClientFromRequest = () => makeClient(state);
  const res = await manageParticipant({ json: async () => body, headers: new Headers() });
  return { status: res.status, data: await res.json() };
}

function roleBody(overrides = {}) {
  return { op: "update", event_id: EVENT, participant_id: "part_1", data: { role_in_event: "speaker" }, ...overrides };
}

function recoverBody(overrides = {}) {
  return { op: "recoverRoleAudit", event_id: EVENT, participant_id: "part_1", ...overrides };
}

function roleAudits(state) {
  return state.audits.filter((a) => a.action === "role_change");
}

function accessAudits(state) {
  return state.audits.filter((a) => String(a.audit_key || "").startsWith("reviewer_reactivation|"));
}

function roleOf(state, id = "part_1") {
  return state.participants.find((p) => p.id === id)?.role_in_event;
}

function pendingOf(state, id = "part_1") {
  return String(state.participants.find((p) => p.id === id)?.role_audit_pending || "");
}

function lockedOf(state, id = "part_1") {
  return state.participants.find((p) => p.id === id)?.role_change_locked === true;
}

// ---------------------------------------------------------------------------
// P1-A — PORTA DE INTEGRIDADE da alteração de papel
//
// Defeito corrigido: A aplicada sem auditoria e B aplicada antes da recuperação
// de A sobrescrevia o token de A (o token pertence ao estado, não ao histórico).
// A recuperação de A devolvia 'superada' — correto para não inventar a transição,
// porém A ficava efetivada e sem trilha para sempre.
// ---------------------------------------------------------------------------
test("HTTP-48 — A sem auditoria bloqueia B: nada é sobrescrito nem perdido", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  const a = await invoke(f.state, roleBody());

  assert.equal(a.status, 503);
  assert.equal(a.data.applied, true);
  assert.equal(a.data.role_change_blocked, true);
  const pendingA = pendingOf(f.state);
  assert.ok(pendingA, "a ocorrência aplicada fica marcada como pendente");
  assert.equal(lockedOf(f.state), true, "o claim permanece com a ocorrência sem trilha");
  f.state.faults.anyAudit = false;

  const b = await invoke(f.state, roleBody({ data: { role_in_event: "attendee" } }));

  assert.equal(b.status, 409);
  assert.equal(b.data.applied, false);
  assert.equal(b.data.role_change_blocked, true);
  assert.equal(b.data.pending_occurrence, pendingA);
  assert.equal(roleOf(f.state), "speaker", "B não alterou o papel");
  assert.equal(f.state.evidence.length, 1, "B não criou evidência");
  assert.equal(roleAudits(f.state).length, 0, "nada declarado auditado");
});

test("HTTP-49 — duas alterações concorrentes: exatamente uma vence", async () => {
  const f = fixture();
  const [x, y] = await Promise.all([
    invoke(f.state, roleBody({ data: { role_in_event: "speaker" } })),
    invoke(f.state, roleBody({ data: { role_in_event: "partner_rep" } })),
  ]);

  const winners = [x, y].filter((r) => r.status === 200);
  const losers = [x, y].filter((r) => r.status === 409);
  assert.equal(winners.length, 1, "um único vencedor");
  assert.equal(losers.length, 1, "a perdedora recebe conflito explícito");
  assert.equal(losers[0].data.conflict, "role_change_concurrent");
  assert.equal(losers[0].data.applied, false);

  const applied = f.state.evidence.filter((e) => e.state !== "not_applied");
  const discarded = f.state.evidence.filter((e) => e.state === "not_applied");
  assert.equal(applied.length, 1);
  assert.equal(discarded.length, 1, "a tentativa perdedora é encerrada, não bloqueia");
  assert.equal(roleAudits(f.state).length, 1);
  assert.equal(roleOf(f.state), applied[0].new_value, "o papel é o do vencedor");
  assert.equal(applied[0].state, "audit_recorded");
  assert.equal(pendingOf(f.state), "", "trilha gravada: nada fica pendente");
  assert.equal(lockedOf(f.state), false, "a porta foi liberada com a trilha");
});

test("HTTP-50 — retry da alteração A com trilha pendente não 'sucede' silenciosamente", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  await invoke(f.state, roleBody());
  f.state.faults.anyAudit = false;

  const retry = await invoke(f.state, roleBody());

  assert.equal(retry.status, 409);
  assert.equal(retry.data.role_change_blocked, true);
  assert.equal(f.state.evidence.length, 1, "nenhuma evidência nova");
  assert.equal(roleAudits(f.state).length, 0, "o retry não declara auditoria inexistente");
});

test("HTTP-51 — recuperação de A libera a porta e B passa a ser permitida", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  await invoke(f.state, roleBody());
  assert.ok(pendingOf(f.state));
  f.state.faults.anyAudit = false;

  const rec = await invoke(f.state, recoverBody());

  assert.equal(rec.status, 200);
  assert.equal(rec.data.audit_state, "recorded");
  assert.equal(rec.data.role_change_blocked, false);
  assert.equal(pendingOf(f.state), "");
  assert.equal(lockedOf(f.state), false);

  const b = await invoke(f.state, roleBody({ data: { role_in_event: "attendee" } }));
  assert.equal(b.status, 200);
  assert.equal(b.data.audit_state, "recorded");
  assert.equal(roleOf(f.state), "attendee");
  assert.equal(roleAudits(f.state).length, 2);
});

test("HTTP-52 — falha ao consultar evidências: recuperação fail-closed", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  await invoke(f.state, roleBody());
  f.state.faults.anyAudit = false;
  f.state.faults.evidenceQuery = true;

  const rec = await invoke(f.state, recoverBody());

  assert.equal(rec.status, 503);
  assert.equal(rec.data.audit_state, "unavailable");
  assert.equal(rec.data.recovered, false);
  assert.equal(f.state.audits.length, 0, "sem leitura não há trilha nem pendência");
  assert.ok(pendingOf(f.state), "a pendência permanece preservada");

  const blocked = await invoke(f.state, roleBody({ data: { role_in_event: "attendee" } }));
  assert.equal(blocked.status, 409, "a porta segue fechada: a trilha continua ausente");
  assert.equal(roleOf(f.state), "speaker");
});

test("HTTP-53 — trilha apenas PENDENTE não libera; a porta se recupera quando a trilha aparece", async () => {
  const f = fixture();
  f.state.faults.mainAudit = true;
  const a = await invoke(f.state, roleBody());

  assert.equal(a.status, 200);
  assert.equal(a.data.audit_state, "pending");
  assert.equal(a.data.role_change_blocked, true, "pendência registrada não é trilha gravada");
  const pending = pendingOf(f.state);
  assert.ok(pending);
  f.state.faults.mainAudit = false;

  const b = await invoke(f.state, roleBody({ data: { role_in_event: "attendee" } }));
  assert.equal(b.status, 409);
  assert.equal(b.data.role_change_blocked, true);

  // A varredura de manutenção grava a trilha com a MESMA chave determinística.
  f.state.audits.push({
    id: "AuditLog_maint",
    audit_key: `role_change|${pending}`,
    action: "role_change",
    entity_type: "Participant",
    entity_id: "part_1",
    user_id: "system",
    event_id: EVENT,
    mandatory: true,
    status: "recorded",
    created_date: "2026-01-01T00:10:00.000Z",
  });

  const b2 = await invoke(f.state, roleBody({ data: { role_in_event: "attendee" } }));
  assert.equal(b2.status, 200, "a porta detectou a trilha por leitura e liberou");
  assert.equal(b2.data.audit_state, "recorded");
  assert.equal(roleOf(f.state), "attendee");
  const keys = roleAudits(f.state).map((x) => x.audit_key);
  assert.equal(new Set(keys).size, 2, "a trilha anterior não é duplicada");
});

test("HTTP-54 — pendência de um participante não bloqueia outro", async () => {
  const f = fixture();
  f.state.faults.anyAudit = true;
  await invoke(f.state, roleBody());
  f.state.faults.anyAudit = false;

  const other = await invoke(f.state, roleBody({ participant_id: "part_3" }));

  assert.equal(other.status, 200);
  assert.equal(other.data.audit_state, "recorded");
  assert.equal(roleOf(f.state, "part_3"), "speaker");
  assert.ok(pendingOf(f.state), "part_1 continua pendente");
  assert.equal(pendingOf(f.state, "part_3"), "");
});

test("HTTP-55 — nenhuma alteração efetivada fica sem trilha recuperável", async () => {
  const f = fixture();
  // 1) Aplicada com auditoria indisponível (ocorrência pendente).
  f.state.faults.anyAudit = true;
  await invoke(f.state, roleBody());
  f.state.faults.anyAudit = false;
  // 2) Recuperação de A.
  const rec = await invoke(f.state, recoverBody());
  assert.equal(rec.status, 200);
  // 3) Outra alteração, agora com trilha apenas pendente.
  f.state.faults.mainAudit = true;
  await invoke(f.state, roleBody({ participant_id: "part_3" }));

  const trailKeys = new Set(f.state.audits.map((x) => String(x.audit_key || "")));
  for (const ev of f.state.evidence) {
    if (ev.state === "not_applied") continue;
    const hasTrail = trailKeys.has(`role_change|${ev.occurrence}`);
    const isPending = pendingOf(f.state, ev.entity_id) === ev.occurrence;
    assert.ok(hasTrail || isPending, `ocorrência ${ev.occurrence} sem trilha e sem pendência`);
  }

  f.state.faults.mainAudit = false;
  const pendingRec = await invoke(f.state, recoverBody({ participant_id: "part_3" }));
  assert.equal(pendingRec.status, 200);
  assert.equal(pendingRec.data.audit_state, "recorded");
  assert.equal(pendingOf(f.state, "part_3"), "");
});

test("HTTP-56 — falha de escrita do participante não deixa mutação nem trilha", async () => {
  const f = fixture();
  f.state.faults.participantWrite = true;

  const res = await invoke(f.state, roleBody());

  assert.equal(res.status, 503);
  assert.equal(res.data.applied, false);
  assert.equal(roleOf(f.state), "attendee");
  assert.equal(roleAudits(f.state).length, 0);
  assert.equal(f.state.evidence.length, 1, "a evidência da ocorrência é preservada");
  assert.equal(f.state.evidence[0].state, "started", "nunca promovida a 'applied' sem prova");
  assert.equal(pendingOf(f.state), "", "sem escrita não há pendência de auditoria");
});

// ---------------------------------------------------------------------------
// P1-B — VÍNCULO CONFIRMADO reviewer ↔ conta ↔ Person
//
// A F3-15 provava o titular por igualdade de e-mail. E-mail é mutável e
// reutilizável: coincidência não prova que a conta pertence à Pessoa. A prova
// passou a ser User.person_id === membership.person_id.
// ---------------------------------------------------------------------------
function reviewerBody(overrides = {}) {
  return { op: "setReviewer", event_id: EVENT, enable: true, ...overrides };
}

test("SR-14 — e-mail coincidente com vínculo de OUTRA pessoa é recusado", async () => {
  const f = fixture();
  const res = await invoke(f.state, reviewerBody({ membership_id: "mem_email_coincident" }));

  assert.equal(res.status, 409);
  assert.equal(res.data.reason, "identity_mismatch");
  assert.match(res.data.error, /outra pessoa/i);
  assert.equal(f.state.memberships.find((m) => m.id === "mem_email_coincident").is_active, false);
  assert.equal(accessAudits(f.state).length, 0);
});

test("SR-15 — snapshot de e-mail divergente não invalida o vínculo comprovado", async () => {
  const f = fixture();
  const res = await invoke(f.state, reviewerBody({ membership_id: "mem_snapshot_stale" }));

  assert.equal(res.status, 200);
  const membership = f.state.memberships.find((m) => m.id === "mem_snapshot_stale");
  assert.equal(membership.is_active, true);
  assert.equal(membership.user_email, "rev.atual@teste.dev", "snapshot regravado com o e-mail atual");
  const details = JSON.parse(accessAudits(f.state)[0].details);
  assert.equal(details.person_link_confirmed, "person_2", "prova registrada na trilha");
  assert.equal(details.snapshot_email_mismatch, true, "divergência registrada, não usada como prova");
});

test("SR-16 — body.user_id e body.user_email não são prova de identidade", async () => {
  const f = fixture();
  const res = await invoke(f.state, reviewerBody({
    membership_id: "mem_rev",
    user_id: "user_1",
    user_email: "gerente@teste.dev",
    person_id: "person_2",
  }));

  assert.equal(res.status, 200);
  const membership = f.state.memberships.find((m) => m.id === "mem_rev");
  assert.equal(membership.user_id, "user_2", "titular vem do vínculo persistido");
  assert.equal(membership.user_email, "rev@teste.dev");
});

test("SR-17 — conta sem vínculo User↔Person é recusada e exige regularização", async () => {
  const f = fixture();
  const res = await invoke(f.state, reviewerBody({ membership_id: "mem_legacy_account" }));

  assert.equal(res.status, 409);
  assert.equal(res.data.reason, "account_person_link_missing");
  assert.match(res.data.error, /vínculo de pessoa/i);
  assert.equal(f.state.memberships.find((m) => m.id === "mem_legacy_account").is_active, false);
  assert.equal(accessAudits(f.state).length, 0);
});

test("SR-18 — vínculo de outro evento continua recusado após F3-16", async () => {
  const f = fixture();
  const res = await invoke(f.state, reviewerBody({ membership_id: "mem_other_event" }));

  assert.equal(res.status, 404);
  assert.equal(f.state.memberships.find((m) => m.id === "mem_other_event").is_active, false);
  assert.equal(accessAudits(f.state).length, 0);
});

test("SR-19 — retry de reativação já concluída converge na mesma trilha", async () => {
  const f = fixture();
  const first = await invoke(f.state, reviewerBody({ membership_id: "mem_rev" }));
  const again = await invoke(f.state, reviewerBody({ membership_id: "mem_rev" }));

  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(again.data.already_active, true);
  assert.equal(accessAudits(f.state).length, 1, "nenhuma trilha duplicada");
});