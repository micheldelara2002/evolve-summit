// F4-01 (AUD-02) — TESTES DE CAMINHO HTTP DA CONSISTÊNCIA DO CHECK-IN.
//
// `checkinTicket/entry.ts` é chamada de ponta a ponta: guard de conta, gate de
// evento, claim CAS do ingresso e sincronização do participante. O SDK é
// substituído por um cliente falso injetado — sem rede e sem dados reais.
//
// LIMITE DECLARADO: o banco falso aplica `updateMany` atomicamente por documento.
// Concorrência aqui é provada por FÓRMULA (CAS decide um vencedor); latência,
// réplica de leitura e timeout reais dependem de homologação.
import test from "node:test";
import assert from "node:assert/strict";
import checkinTicket from "../../base44/functions/checkinTicket/entry.ts";

function matchesValue(actual, cond) {
  if (cond === undefined) return true;
  if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
    if ("$exists" in cond) return cond.$exists ? actual !== undefined : actual === undefined;
    if ("$lte" in cond) return actual !== undefined && actual !== null && actual <= cond.$lte;
    if ("$gte" in cond) return actual !== undefined && actual !== null && actual >= cond.$gte;
    if ("$lt" in cond) return actual !== undefined && actual !== null && actual < cond.$lt;
    if ("$gt" in cond) return actual !== undefined && actual !== null && actual > cond.$gt;
    if ("$ne" in cond) return actual !== cond.$ne;
    if ("$in" in cond) return cond.$in.includes(actual);
    return JSON.stringify(actual) === JSON.stringify(cond);
  }
  return actual === cond;
}

function matches(doc, query = {}) {
  return Object.entries(query).every(([key, cond]) => matchesValue(doc[key], cond));
}

function applyUpdate(doc, update = {}) {
  for (const [op, payload] of Object.entries(update)) {
    if (op === "$set") Object.assign(doc, payload);
    else if (op === "$inc") for (const [k, v] of Object.entries(payload)) doc[k] = (Number(doc[k]) || 0) + v;
    else throw new Error(`fake: operador não suportado (${op})`);
  }
}

function fixture() {
  return {
    faults: { participantWrite: false, participantRead: false },
    users: [{ id: "user_1", full_name: "Staff Teste", email: "staff@teste.dev", role: "user", account_status: "active" }],
    memberships: [
      { id: "mem_1", event_id: "ev_1", user_id: "user_1", role: "team", is_active: true, is_deleted: false },
    ],
    tickets: [
      {
        id: "tk_1", event_id: "ev_1", hash_code: "HASH1", holder_name: "Fulano",
        ticket_type_name: "Geral", status: "issued", used_at: "", participant_id: "part_1", is_deleted: false,
      },
      {
        id: "tk_other", event_id: "ev_2", hash_code: "HASH2", holder_name: "Outro",
        ticket_type_name: "Geral", status: "issued", used_at: "", participant_id: "part_2", is_deleted: false,
      },
    ],
    participants: [
      {
        id: "part_1", event_id: "ev_1", full_name: "Fulano", email: "fulano@teste.dev",
        checkin_status: "pending", checkin_at: null, checked_in_by_user_id: null,
        registration_status: "confirmed", is_deleted: false,
      },
      {
        id: "part_2", event_id: "ev_2", full_name: "Outro", email: "outro@teste.dev",
        checkin_status: "pending", checkin_at: null, checked_in_by_user_id: null,
        registration_status: "confirmed", is_deleted: false,
      },
    ],
    audits: [],
  };
}

function collection(rows, name, state) {
  return {
    async filter(query = {}) {
      if (name === "Participant" && state.faults.participantRead) {
        throw new Error("leitura de participante indisponível");
      }
      return rows.filter((row) => matches(row, query)).map((row) => ({ ...row }));
    },
    async get(id) {
      const row = rows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    async create(data = {}) {
      const row = { id: `${name}_${rows.length + 1}`, created_date: new Date().toISOString(), is_deleted: false, ...data };
      rows.push(row);
      return { ...row };
    },
    async update(id, data = {}) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error("registro não encontrado");
      Object.assign(row, data);
      return { ...row };
    },
    async updateMany(query = {}, update = {}) {
      if (name === "Participant" && state.faults.participantWrite) {
        throw new Error("escrita de participante indisponível");
      }
      const targets = rows.filter((row) => matches(row, query));
      for (const row of targets) applyUpdate(row, update);
      return { updated: targets.length };
    },
  };
}

function makeClient(state) {
  const entities = {
    User: collection(state.users, "User", state),
    EventMembership: collection(state.memberships, "EventMembership", state),
    Ticket: collection(state.tickets, "Ticket", state),
    Participant: collection(state.participants, "Participant", state),
    AuditLog: collection(state.audits, "AuditLog", state),
  };
  return {
    auth: { me: async () => ({ ...state.users[0] }) },
    asServiceRole: { entities },
  };
}

async function invoke(state, body) {
  globalThis.__base44ClientFromRequest = () => makeClient(state);
  const res = await checkinTicket({ json: async () => body, headers: new Headers() });
  return { status: res.status, data: await res.json() };
}

function ticketOf(state, id = "tk_1") {
  return state.tickets.find((t) => t.id === id);
}

function participantOf(state, id = "part_1") {
  return state.participants.find((p) => p.id === id);
}

function trailsOf(state, type) {
  return state.audits.filter((a) => String(a.details || "").includes(type));
}

// ---------------------------------------------------------------------------
// Caminho novo
// ---------------------------------------------------------------------------
test("F4-02/1 — check-in válido sincroniza o participante", async () => {
  const state = fixture();
  const res = await invoke(state, { code: "HASH1" });

  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.participant_sync, "sincronizado");
  assert.equal(ticketOf(state).status, "used");
  const part = participantOf(state);
  assert.equal(part.checkin_status, "confirmed");
  assert.equal(part.checked_in_by_user_id, "user_1");
  assert.ok(part.checkin_at);
});

test("F4-02/2 — falha ao sincronizar após marcar 'used': resposta explícita e estado recuperável", async () => {
  const state = fixture();
  state.faults.participantWrite = true;

  const res = await invoke(state, { code: "HASH1" });

  assert.equal(res.status, 503);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.status, "used");
  assert.equal(res.data.retry_sync, true);
  assert.equal(res.data.participant_sync, "falha_escrita");
  assert.equal(ticketOf(state).status, "used", "ingresso validado");
  assert.equal(participantOf(state).checkin_status, "pending", "participante pendente, não perdido");
  assert.equal(trailsOf(state, "ticket_checkin_sync_failed").length, 1, "falha registrada");
});

test("F4-02/3 — retry após a falha REPARA a sincronização do participante", async () => {
  const state = fixture();
  state.faults.participantWrite = true;
  await invoke(state, { code: "HASH1" });

  state.faults.participantWrite = false;
  const retry = await invoke(state, { code: "HASH1" });

  assert.equal(retry.status, 200);
  assert.equal(retry.data.ok, false, "continua bloqueando entrada nova");
  assert.equal(retry.data.status, "used");
  assert.equal(retry.data.repaired, true);
  assert.equal(retry.data.participant_sync, "sincronizado");
  assert.equal(participantOf(state).checkin_status, "confirmed");
  assert.equal(trailsOf(state, "ticket_checkin_repaired").length, 1);
});

test("F4-02/4 — participante já sincronizado não sofre efeito novo (nem sobrescreve autoria)", async () => {
  const state = fixture();
  await invoke(state, { code: "HASH1" });
  const first = { ...participantOf(state) };

  const again = await invoke(state, { code: "HASH1" });

  assert.equal(again.data.repaired, false);
  assert.equal(again.data.participant_sync, "sincronizado");
  assert.equal(participantOf(state).checkin_at, first.checkin_at, "instante do check-in preservado");
  assert.equal(participantOf(state).checked_in_by_user_id, first.checked_in_by_user_id);
});

test("F4-02/5 — duas tentativas concorrentes: uma valida, a outra reconhece 'used'", async () => {
  const state = fixture();

  const [a, b] = await Promise.all([
    invoke(state, { code: "HASH1" }),
    invoke(state, { code: "HASH1" }),
  ]);

  const confirmed = [a, b].filter((r) => r.data.ok === true);
  const duplicates = [a, b].filter((r) => r.data.ok === false);
  assert.equal(confirmed.length, 1, "exatamente um check-in efetivado");
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].data.status, "used");
  assert.equal(participantOf(state).checkin_status, "confirmed");
  assert.equal(trailsOf(state, "ticket_checkin").length, 1, "trilha do check-in não duplica");
});

test("F4-02/6 — check-in duplicado não produz efeito duplicado", async () => {
  const state = fixture();
  const first = await invoke(state, { code: "HASH1" });
  const stamp = participantOf(state).checkin_at;
  const second = await invoke(state, { code: "HASH1" });
  const third = await invoke(state, { code: "HASH1" });

  assert.equal(first.data.ok, true);
  assert.equal(second.data.ok, false);
  assert.equal(third.data.ok, false);
  assert.equal(participantOf(state).checkin_at, stamp, "um único instante de check-in");
  assert.equal(state.audits.filter((a) => String(a.details || "").includes("ticket_checkin")).length, 1);
});

// ---------------------------------------------------------------------------
// Escopo e casos de borda
// ---------------------------------------------------------------------------
test("F4-02/7 — ingresso de outro evento: 403 e nenhuma escrita", async () => {
  const state = fixture();

  const res = await invoke(state, { code: "HASH2" });

  assert.equal(res.status, 403);
  assert.equal(ticketOf(state, "tk_other").status, "issued");
  assert.equal(participantOf(state, "part_2").checkin_status, "pending");
  assert.equal(state.audits.length, 0);
});

test("F4-02/8 — participante inexistente: check-in válido, nada é criado ou reparado", async () => {
  const state = fixture();
  ticketOf(state).participant_id = "part_x";

  const res = await invoke(state, { code: "HASH1" });

  assert.equal(res.status, 200);
  assert.equal(res.data.participant_sync, "participante_inexistente");
  assert.equal(state.participants.length, 2, "nenhum participante criado");
  assert.equal(trailsOf(state, "ticket_checkin_participant_unavailable").length, 1);
});

test("F4-02/9 — participante cancelado não é confirmado pela reparação", async () => {
  const state = fixture();
  participantOf(state).registration_status = "cancelled";

  const res = await invoke(state, { code: "HASH1" });

  assert.equal(res.data.participant_sync, "participante_cancelado");
  assert.equal(participantOf(state).checkin_status, "pending", "cancelado não vira presença");

  const retry = await invoke(state, { code: "HASH1" });
  assert.equal(retry.data.participant_sync, "participante_cancelado");
  assert.equal(participantOf(state).checkin_status, "pending");
});

test("F4-02/10 — leitura do participante indisponível: erro explícito, nada declarado sincronizado", async () => {
  const state = fixture();
  state.faults.participantRead = true;

  const res = await invoke(state, { code: "HASH1" });

  assert.equal(res.status, 503);
  assert.equal(res.data.participant_sync, "falha_leitura");
  assert.equal(res.data.retry_sync, true);
  assert.equal(participantOf(state).checkin_status, "pending");

  state.faults.participantRead = false;
  const retry = await invoke(state, { code: "HASH1" });
  assert.equal(retry.data.repaired, true);
  assert.equal(participantOf(state).checkin_status, "confirmed");
});

test("F4-02/11 — falha durante a reparação: erro mantido e nova tentativa conclui", async () => {
  const state = fixture();
  state.faults.participantWrite = true;
  await invoke(state, { code: "HASH1" }); // ingresso marcado used, sync falhou

  const blocked = await invoke(state, { code: "HASH1" });
  assert.equal(blocked.status, 503, "reparação também falha explicitamente");
  assert.equal(blocked.data.repaired, false);
  assert.equal(participantOf(state).checkin_status, "pending");

  state.faults.participantWrite = false;
  const ok = await invoke(state, { code: "HASH1" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.repaired, true);
  assert.equal(participantOf(state).checkin_status, "confirmed");
});

test("F4-02/12 — ingresso cancelado/estornado continua bloqueado sem tocar o participante", async () => {
  const state = fixture();
  ticketOf(state).status = "refunded";

  const res = await invoke(state, { code: "HASH1" });

  assert.equal(res.data.ok, false);
  assert.equal(res.data.status, "refunded");
  assert.equal(ticketOf(state).status, "refunded");
  assert.equal(participantOf(state).checkin_status, "pending");
});