// F3-13 (2026-11-12) — trilha de mudança de acesso (base44/shared/accessAudit.ts).
//
// Cobre o contrato do helper usado pelos caminhos de concessão/revogação que
// NÃO podem derrubar o fluxo legítimo (convite, aprovação de pauta, vínculo de
// parceiro): trilha confirmada, pendência confirmada por leitura e estado
// explícito quando nada pôde ser persistido. Nenhum caso 'unavailable' declara
// sucesso auditado.
import test from "node:test";
import assert from "node:assert/strict";
import { recordAccessChange } from "../../base44/shared/accessAudit.ts";

function fakeSvc({ failMain = false, failAny = false, failRead = false } = {}) {
  const rows = [];
  return {
    rows,
    svc: {
      entities: {
        AuditLog: {
          filter: async (query = {}) => {
            if (failRead) throw new Error("leitura indisponível");
            return rows.filter((r) => Object.entries(query).every(([k, v]) => r[k] === v)).map((r) => ({ ...r }));
          },
          create: async (data = {}) => {
            const isPending = String(data.audit_key || "").endsWith("|pending");
            if (failAny) throw new Error("AuditLog indisponível");
            if (failMain && !isPending) throw new Error("AuditLog indisponível (principal)");
            const row = { id: `audit_${rows.length + 1}`, ...data };
            rows.push(row);
            return { ...row };
          },
          delete: async () => ({ ok: true }),
        },
      },
    },
  };
}

const base = {
  eventId: "evt_1",
  entityType: "EventMembership",
  entityId: "mem_1",
  actor: { id: "user_1", full_name: "Gerente" },
  operation: "role_grant",
  reference: "mem_1",
  details: { role: "team" },
};

test("ACCESS-1 — trilha gravada e confirmada", async () => {
  const f = fakeSvc();
  const state = await recordAccessChange(f.svc, base);

  assert.equal(state, "recorded");
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].mandatory, true);
  assert.equal(f.rows[0].status, "recorded");
  assert.equal(f.rows[0].audit_key, "role_grant|mem_1");
  assert.equal(f.rows[0].user_id, "user_1");
});

test("ACCESS-2 — principal falha: pendência persistida e relida", async () => {
  const f = fakeSvc({ failMain: true });
  const state = await recordAccessChange(f.svc, base);

  assert.equal(state, "pending");
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].status, "pending");
  assert.equal(f.rows[0].audit_key, "role_grant|mem_1|pending");
});

test("ACCESS-3 — nada persistido: estado explícito, nenhuma trilha falsa", async () => {
  const f = fakeSvc({ failAny: true });
  const state = await recordAccessChange(f.svc, base);

  assert.equal(state, "unavailable");
  assert.equal(f.rows.length, 0);
});

test("ACCESS-4 — leitura de confirmação falha: pendência não é declarada", async () => {
  const f = fakeSvc({ failRead: true });
  const state = await recordAccessChange(f.svc, base);

  assert.equal(state, "unavailable");
});

test("ACCESS-5 — repetir a mesma ocorrência não duplica trilha", async () => {
  const f = fakeSvc();
  await recordAccessChange(f.svc, base);
  const again = await recordAccessChange(f.svc, base);

  assert.equal(again, "recorded");
  assert.equal(f.rows.length, 1, "chave determinística garantiu idempotência");
});

test("ACCESS-6 — ocorrências diferentes geram trilhas distintas", async () => {
  const f = fakeSvc();
  await recordAccessChange(f.svc, base);
  await recordAccessChange(f.svc, { ...base, entityId: "mem_2", reference: "mem_2" });

  assert.equal(f.rows.length, 2);
  assert.equal(new Set(f.rows.map((r) => r.audit_key)).size, 2);
});

test("ACCESS-7 — sem ator a trilha é do sistema, nunca anônima", async () => {
  const f = fakeSvc();
  await recordAccessChange(f.svc, { ...base, actor: null });

  assert.equal(f.rows[0].user_id, "system");
});