// Fase 2 (2026-11-12) — MIGRAÇÃO EventFinance: paginação, exclusão lógica e
// trilha obrigatória bloqueante.
//
// Exercita o MÓDULO DE PRODUÇÃO `base44/shared/eventFinanceMigration.ts` (o mesmo
// que a função `migrateEventFinance` chama) contra um fake com cursor keyset.
//
// O que estes testes provam: nenhum evento é pulado ou migrado duas vezes; o
// legado nunca é apagado antes de o dado estar em EventFinance e a trilha
// gravada; toda falha é reportada com o estágio exato e recuperável.
// O que NÃO provam: concorrência real de banco, transações entre coleções,
// comportamento do SDK real de produção.
//
// Execução: npm run test:unit:migration

import test from "node:test";
import assert from "node:assert/strict";

import { createFakeEventDb, legacyEvent } from "./lib/fakeEventDb.mjs";
import { migrateEventFinanceBatch } from "../../base44/shared/eventFinanceMigration.ts";

const ACTOR = { id: "admin_1", name: "Admin Teste" };

function run(db, over = {}) {
  return migrateEventFinanceBatch(db.svc, { dryRun: false, limit: 3, actor: ACTOR, ...over });
}

function events(n, over = () => ({})) {
  return Array.from({ length: n }, (_, i) => legacyEvent(i + 1, over(i + 1)));
}

function assertLegacyIntact(db, eventId, expectedPayout, expectedCoupons) {
  const ev = db.event(eventId);
  assert.equal(ev.payout_account_id, expectedPayout, `legado de ${eventId} preservado`);
  assert.ok(ev.refund_policy, `refund_policy de ${eventId} preservado`);
  const coupons = expectedCoupons || [`CUPOM${Number(eventId.split("_")[1])}`];
  assert.deepEqual(ev.coupon_codes_registry, coupons);
}

// ---------------------------------------------------------------------------
// 1. Paginação completa com mais de um lote
// ---------------------------------------------------------------------------

test("1 — paginação real: 7 eventos em lotes de 3 são todos migrados, sem omissão", async () => {
  const db = createFakeEventDb({ events: events(7) });

  const p1 = await run(db);
  assert.equal(p1.mode, "batch");
  assert.equal(p1.scanned, 3);
  assert.equal(p1.created, 3);
  assert.equal(p1.has_more, true);
  assert.ok(p1.next_cursor, "cursor devolvido para continuar");
  assert.equal(p1.complete, false);

  const p2 = await run(db, { cursor: p1.next_cursor });
  assert.equal(p2.cursor_used, p1.next_cursor, "continua do cursor recebido");
  assert.equal(p2.scanned, 3);

  const p3 = await run(db, { cursor: p2.next_cursor });
  assert.equal(p3.scanned, 1);
  assert.equal(p3.created, 1);
  assert.equal(p3.has_more, false, "fim da coleção");
  assert.equal(p3.next_cursor, null);

  // Nenhum evento pulado, nenhum documento duplicado.
  assert.equal(db.events.length, 7, "nenhum evento removido");
  assert.equal(db.finances.length, 7, "um documento financeiro por evento");
  assert.equal(new Set(db.finances.map((f) => f.event_id)).size, 7, "sem duplicidade");
  assert.equal(db.auditLogs.length, 7, "uma trilha por evento");
  assert.equal(p1.created + p2.created + p3.created, 7);

  for (const ev of db.events) {
    assert.equal(ev.commission_percent, null, `${ev.id}: comissão limpa`);
    assert.equal(ev.payout_account_id, "", `${ev.id}: conta limpa`);
    assert.equal(ev.refund_policy, "", `${ev.id}: política limpa`);
    assert.deepEqual(ev.coupon_codes_registry, [], `${ev.id}: registro de cupons limpo`);
    assert.ok(db.finance(ev.id), `${ev.id}: documento financeiro existe`);
  }
});

// ---------------------------------------------------------------------------
// 2. Continuidade pelo cursor (ordem preservada entre páginas)
// ---------------------------------------------------------------------------

test("2 — cada página avança exatamente 3 eventos, na ordem estável", async () => {
  const db = createFakeEventDb({ events: events(7) });

  const p1 = await run(db);
  assert.deepEqual(db.finances.map((f) => f.event_id), ["ev_001", "ev_002", "ev_003"]);

  const p2 = await run(db, { cursor: p1.next_cursor });
  assert.deepEqual(
    db.finances.map((f) => f.event_id),
    ["ev_001", "ev_002", "ev_003", "ev_004", "ev_005", "ev_006"],
    "a segunda página continua depois da primeira",
  );

  const p3 = await run(db, { cursor: p2.next_cursor });
  assert.deepEqual(
    db.finances.map((f) => f.event_id),
    ["ev_001", "ev_002", "ev_003", "ev_004", "ev_005", "ev_006", "ev_007"],
  );
  assert.equal(p3.scanned, 1);
});

// ---------------------------------------------------------------------------
// 3. Reexecução sem duplicidade
// ---------------------------------------------------------------------------

test("3 — reexecução do zero: nada é recriado, nada é re-auditado", async () => {
  const db = createFakeEventDb({ events: events(4) });

  const first = await run(db, { limit: 10 });
  assert.equal(first.created, 4);
  assert.equal(db.auditLogs.length, 4);

  const again = await run(db, { limit: 10 });
  assert.equal(again.ok, true);
  assert.equal(again.created, 0);
  assert.equal(again.merged, 0);
  assert.equal(again.cleared_only, 0);
  assert.equal(again.already_clean, 4, "todos reconhecidos como já migrados");
  assert.equal(db.finances.length, 4, "nenhum documento duplicado");
  assert.equal(db.auditLogs.length, 4, "trilha não duplica");
});

// ---------------------------------------------------------------------------
// 4–6. Tipos de evento: ativo, finalizado, excluído logicamente
// ---------------------------------------------------------------------------

test("4 — evento ativo: migra e limpa o legado", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(1, { status: "active" })] });

  const res = await run(db, { eventId: "ev_001" });

  assert.equal(res.ok, true);
  assert.equal(res.mode, "single");
  assert.equal(res.created, 1);
  assert.equal(db.event("ev_001").status, "active", "status do evento intacto");
  assert.equal(db.event("ev_001").payout_account_id, "");
  assert.equal(db.finance("ev_001").payout_account_id, "acct_1");
});

test("5 — evento finalizado: migra e limpa o legado", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(2, { status: "finished" })] });

  const res = await run(db, { eventId: "ev_002" });

  assert.equal(res.ok, true);
  assert.equal(db.event("ev_002").status, "finished");
  assert.equal(db.event("ev_002").refund_policy, "");
  assert.ok(db.finance("ev_002").refund_policy, "política preservada no documento financeiro");
});

test("6 — evento excluído logicamente: também migra (não fica exposto) e continua excluído", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(3, { is_deleted: true, status: "cancelled" })] });

  const res = await run(db, { eventId: "ev_003" });

  assert.equal(res.ok, true);
  assert.equal(res.details[0].soft_deleted, true, "marcado como exclusão lógica");
  assert.equal(db.event("ev_003").is_deleted, true, "continua logicamente excluído");
  assert.equal(db.events.length, 1, "evento NÃO é apagado (exclusão física não é feita)");
  assert.equal(db.event("ev_003").payout_account_id, "", "legado limpo — RLS não expõe mais nada");
  assert.equal(db.finance("ev_003").payout_account_id, "acct_3", "valor preservado no documento");
  assert.equal(db.auditLogs.length, 1);
});

// ---------------------------------------------------------------------------
// 7. Falha na criação do EventFinance
// ---------------------------------------------------------------------------

test("7 — falha ao criar EventFinance: legado intacto, sem trilha, execução não avança", async () => {
  const db = createFakeEventDb({ events: events(2) });
  db.svc.entities.EventFinance.create = async () => { throw new Error("criação indisponível"); };

  const res = await run(db, { limit: 10 });

  assert.equal(res.ok, false);
  assert.equal(res.failed, 2);
  assert.equal(res.failures[0].stage, "finance_create");
  assert.match(res.failures[0].error, /criação indisponível/);
  assert.equal(db.finances.length, 0);
  assert.equal(db.auditLogs.length, 0, "nenhuma trilha de sucesso");
  assertLegacyIntact(db, "ev_001", "acct_1");
  assertLegacyIntact(db, "ev_002", "acct_2");
  assert.equal(res.retry_page, true, "página deve ser reexecutada");
  assert.equal(res.next_cursor, null, "cursor de entrada devolvido");
});

// ---------------------------------------------------------------------------
// 8. Falha na atualização do EventFinance
// ---------------------------------------------------------------------------

test("8 — falha ao atualizar EventFinance: valor já configurado preservado e legado intacto", async () => {
  const db = createFakeEventDb({
    events: [legacyEvent(1)],
    finances: [{
      id: "fin_existente",
      event_id: "ev_001",
      commission_percent: 12,
      payout_account_id: "",
      refund_policy: "",
      coupon_codes_registry: [],
    }],
  });
  db.svc.entities.EventFinance.update = async () => { throw new Error("atualização indisponível"); };

  const res = await run(db, { eventId: "ev_001" });

  assert.equal(res.ok, false);
  assert.equal(res.details[0].stage, "finance_update");
  assert.equal(db.finance("ev_001").commission_percent, 12, "valor existente preservado");
  assert.equal(db.finance("ev_001").payout_account_id, "", "nada foi gravado");
  assert.equal(db.event("ev_001").payout_account_id, "acct_1", "legado intacto");
  assert.equal(db.auditLogs.length, 0);
});

// ---------------------------------------------------------------------------
// 9. Falha na limpeza dos campos legados
// ---------------------------------------------------------------------------

test("9 — falha na limpeza: dado e trilha garantidos, legado ainda exposto, reexecução conclui", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(1)] });
  const realUpdate = db.svc.entities.Event.update.bind(db.svc.entities.Event);
  db.svc.entities.Event.update = async () => { throw new Error("evento indisponível"); };

  const res = await run(db, { eventId: "ev_001" });

  assert.equal(res.ok, false);
  assert.equal(res.details[0].stage, "legacy_clear");
  assert.equal(db.finance("ev_001").payout_account_id, "acct_1", "dado JÁ está em EventFinance");
  assert.equal(db.auditLogs.length, 1, "trilha JÁ gravada");
  assertLegacyIntact(db, "ev_001", "acct_1");

  // Recuperação: a reexecução conclui a limpeza sem duplicar documento nem trilha.
  db.svc.entities.Event.update = realUpdate;
  const retry = await run(db, { eventId: "ev_001" });

  assert.equal(retry.ok, true);
  assert.equal(retry.created, 0, "documento não é recriado");
  assert.equal(retry.cleared_only, 1);
  assert.equal(db.finances.length, 1);
  assert.equal(db.auditLogs.length, 1, "trilha não duplicada");
  assert.equal(db.event("ev_001").payout_account_id, "");
});

// ---------------------------------------------------------------------------
// 10. Falha na gravação do AuditLog (trilha obrigatória)
// ---------------------------------------------------------------------------

test("10 — falha na trilha: evento NÃO é limpo e a execução não é declarada concluída", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(1), legacyEvent(2)] });
  const realCreate = db.svc.entities.AuditLog.create.bind(db.svc.entities.AuditLog);
  db.svc.entities.AuditLog.create = async () => { throw new Error("trilha indisponível"); };

  const res = await run(db, { limit: 10 });

  assert.equal(res.ok, false);
  assert.equal(res.audit_failures, 2);
  assert.equal(res.failures[0].stage, "audit");
  assert.match(res.failures[0].error, /Trilha obrigatória não gravada/);

  // O documento financeiro foi gravado (dado preservado), mas o legado continua.
  assert.equal(db.finance("ev_001").payout_account_id, "acct_1");
  assertLegacyIntact(db, "ev_001", "acct_1");
  assertLegacyIntact(db, "ev_002", "acct_2");
  assert.equal(db.auditLogs.length, 0);

  // Trilha volta: a reexecução grava a trilha e só então limpa.
  db.svc.entities.AuditLog.create = realCreate;
  const retry = await run(db, { limit: 10 });

  assert.equal(retry.ok, true);
  assert.equal(retry.created, 0, "documento não recriado");
  assert.equal(db.auditLogs.length, 2);
  assert.equal(db.event("ev_001").payout_account_id, "");
  assert.equal(db.finance("ev_001").payout_account_id, "acct_1");
});

// ---------------------------------------------------------------------------
// 11. Recuperação após falha parcial dentro de uma página
// ---------------------------------------------------------------------------

test("11 — falha parcial na página: cursor não avança e a reexecução fecha tudo sem duplicar", async () => {
  const db = createFakeEventDb({ events: events(3) });
  const realCreate = db.svc.entities.EventFinance.create.bind(db.svc.entities.EventFinance);
  db.svc.entities.EventFinance.create = async (data) => {
    if (data.event_id === "ev_002") throw new Error("falha isolada no ev_002");
    return realCreate(data);
  };

  const p1 = await run(db, { limit: 2 });
  assert.equal(p1.ok, false);
  assert.equal(p1.created, 1, "ev_001 migrado");
  assert.equal(p1.failed, 1, "ev_002 falhou");
  assert.equal(p1.retry_page, true);
  assert.equal(p1.next_cursor, null, "cursor de entrada (null) — a mesma página volta");
  assert.equal(p1.has_more, true);

  db.svc.entities.EventFinance.create = realCreate;

  // Reenvia o cursor devolvido: a página é relida; ev_001 é no-op.
  const retry = await run(db, { limit: 2, cursor: p1.next_cursor });
  assert.equal(retry.ok, true);
  assert.equal(retry.already_clean, 1, "evento já migrado não é reprocessado");
  assert.equal(retry.created, 1, "apenas o que faltava");
  assert.equal(db.finances.length, 2);
  assert.equal(db.auditLogs.length, 2, "uma trilha por evento, sem duplicar");
  assert.equal(db.auditByKey("event_finance_migrado|ev_001").length, 1);

  const p3 = await run(db, { limit: 2, cursor: retry.next_cursor });
  assert.equal(p3.scanned, 1);
  assert.equal(p3.created, 1, "terceiro evento alcançado");
  assert.equal(db.finances.length, 3);
});

// ---------------------------------------------------------------------------
// 12. Preservação de valores já existentes em EventFinance
// ---------------------------------------------------------------------------

test("12 — valor já configurado em EventFinance nunca é sobrescrito pelo legado", async () => {
  const db = createFakeEventDb({
    events: [legacyEvent(1)],
    finances: [{
      id: "fin_existente",
      event_id: "ev_001",
      commission_percent: 12,
      payout_account_id: "",
      refund_policy: "",
      coupon_codes_registry: ["ANTIGO"],
    }],
  });

  const res = await run(db, { eventId: "ev_001" });

  assert.equal(res.ok, true);
  assert.equal(res.merged, 1);

  const fin = db.finance("ev_001");
  assert.equal(fin.commission_percent, 12, "comissão configurada preservada");
  assert.deepEqual(fin.coupon_codes_registry, ["ANTIGO"], "registro existente preservado");
  assert.equal(fin.payout_account_id, "acct_1", "campo vazio completado pelo legado");
  assert.ok(fin.refund_policy, "política vazia completada");
  assert.equal(db.event("ev_001").commission_percent, null, "legado limpo");
});

// ---------------------------------------------------------------------------
// 13. dry_run não escreve nada
// ---------------------------------------------------------------------------

test("13 — dry_run (padrão) não escreve, não audita e não limpa", async () => {
  const db = createFakeEventDb({ events: events(2) });

  const res = await migrateEventFinanceBatch(db.svc, { limit: 10, actor: ACTOR });

  assert.equal(res.dry_run, true);
  assert.equal(res.ok, true);
  assert.equal(res.details[0].action, "create");
  assert.equal(db.finances.length, 0, "nenhum documento criado");
  assert.equal(db.auditLogs.length, 0, "nenhuma trilha");
  assertLegacyIntact(db, "ev_001", "acct_1");
  assertLegacyIntact(db, "ev_002", "acct_2");
});

// ---------------------------------------------------------------------------
// 14. Evento sem legado não gera documento vazio
// ---------------------------------------------------------------------------

test("14 — evento sem campos financeiros não cria documento nem trilha", async () => {
  const db = createFakeEventDb({
    events: [{
      id: "ev_limpo",
      name: "Sem financeiro",
      status: "active",
      is_deleted: false,
      created_date: "2026-01-01T10:00:00.000Z",
    }],
  });

  const res = await run(db, { limit: 10 });

  assert.equal(res.ok, true);
  assert.equal(res.already_clean, 1);
  assert.equal(db.finances.length, 0);
  assert.equal(db.auditLogs.length, 0);
});

// ---------------------------------------------------------------------------
// 15. Escrita "sem persistir" não autoriza a limpeza (proteção contra falso sucesso)
// ---------------------------------------------------------------------------

test("15 — escrita que não persiste impede a limpeza do legado", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(1)] });
  const realCreate = db.svc.entities.EventFinance.create.bind(db.svc.entities.EventFinance);
  // Cria "com sucesso" mas não grava nada (resposta otimista, banco vazio).
  db.svc.entities.EventFinance.create = async () => ({ id: "fin_fantasma" });

  const res = await run(db, { eventId: "ev_001" });

  assert.equal(res.ok, false);
  assert.equal(res.details[0].stage, "finance_confirm");
  assert.match(res.details[0].error, /não encontrado após a escrita|não persistidos/);
  assertLegacyIntact(db, "ev_001", "acct_1");
  assert.equal(db.auditLogs.length, 0);

  db.svc.entities.EventFinance.create = realCreate;
  const retry = await run(db, { eventId: "ev_001" });
  assert.equal(retry.ok, true);
  assert.equal(db.finances.length, 1);
  assert.equal(db.event("ev_001").payout_account_id, "");
});

// ---------------------------------------------------------------------------
// VALIDAÇÃO EXATA DE VALOR (16–24)
//
// A confirmação não aceita "campo preenchido": compara o valor gravado com o
// esperado. Estes testes adulteram o que o banco persiste (resposta otimista com
// valor divergente) e provam que a divergência bloqueia ANTES da trilha e da
// limpeza do legado — e que a reexecução, uma vez corrigida, conclui sem duplicar.
// ---------------------------------------------------------------------------

// Persiste um documento adulterado devolvendo sucesso (o banco não guardou o que
// foi enviado). Devolve a função que restaura o comportamento normal.
function tamperCreate(db, mutate) {
  const realCreate = db.svc.entities.EventFinance.create.bind(db.svc.entities.EventFinance);
  db.svc.entities.EventFinance.create = async (data) => realCreate(mutate({ ...data }));
  return () => { db.svc.entities.EventFinance.create = realCreate; };
}

function tamperUpdate(db, mutate) {
  const realUpdate = db.svc.entities.EventFinance.update.bind(db.svc.entities.EventFinance);
  db.svc.entities.EventFinance.update = async (id, patch) => realUpdate(id, mutate({ ...patch }));
  return () => { db.svc.entities.EventFinance.update = realUpdate; };
}

function existingFinance(over = {}) {
  return {
    id: "fin_existente",
    event_id: "ev_001",
    commission_percent: 12,
    payout_account_id: "",
    refund_policy: "",
    coupon_codes_registry: [],
    ...over,
  };
}

test("16 — valores gravados idênticos: confirmação aprova e a migração conclui", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(1)] });

  const res = await run(db, { eventId: "ev_001" });

  assert.equal(res.ok, true);
  assert.equal(res.created, 1);
  const fin = db.finance("ev_001");
  assert.equal(fin.commission_percent, 10);
  assert.equal(fin.payout_account_id, "acct_1");
  assert.deepEqual(fin.coupon_codes_registry, ["CUPOM1"]);
  assert.equal(db.auditLogs.length, 1, "trilha gravada");
  assert.equal(db.event("ev_001").payout_account_id, "", "legado limpo");
});

test("17 — comissão divergente: bloqueia antes da trilha e preserva o legado", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(1)] });
  tamperCreate(db, (data) => ({ ...data, commission_percent: 15 }));

  const res = await run(db, { eventId: "ev_001" });

  assert.equal(res.ok, false);
  assert.equal(res.details[0].stage, "finance_confirm");
  assert.match(res.details[0].error, /commission_percent divergente/);
  assert.match(res.details[0].error, /esperado número 10, persistido número 15/);
  assert.equal(db.auditLogs.length, 0, "sem trilha de sucesso");
  assertLegacyIntact(db, "ev_001", "acct_1");
});

test("18 — payout_account_id divergente: bloqueia", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(1)] });
  tamperCreate(db, (data) => ({ ...data, payout_account_id: "acct_OUTRA" }));

  const res = await run(db, { eventId: "ev_001" });

  assert.equal(res.ok, false);
  assert.equal(res.details[0].stage, "finance_confirm");
  assert.match(res.details[0].error, /payout_account_id divergente/);
  assert.match(res.details[0].error, /acct_OUTRA/);
  assert.equal(db.auditLogs.length, 0);
  assertLegacyIntact(db, "ev_001", "acct_1");
});

test("19 — refund_policy divergente no merge: bloqueia", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(1)], finances: [existingFinance()] });
  tamperUpdate(db, (patch) => ({ ...patch, refund_policy: JSON.stringify({ full_refund_until_days: 3 }) }));

  const res = await run(db, { eventId: "ev_001" });

  assert.equal(res.ok, false);
  assert.equal(res.details[0].stage, "finance_confirm");
  assert.match(res.details[0].error, /refund_policy divergente/);
  assert.equal(db.auditLogs.length, 0);
  assertLegacyIntact(db, "ev_001", "acct_1");
});

test("20 — coupon_codes_registry com a mesma lista em ordem diferente: bloqueia", async () => {
  const db = createFakeEventDb({
    events: [legacyEvent(1, { coupon_codes_registry: ["CA", "CB"] })],
  });
  tamperCreate(db, (data) => ({ ...data, coupon_codes_registry: ["CB", "CA"] }));

  const res = await run(db, { eventId: "ev_001" });

  assert.equal(res.ok, false);
  assert.equal(res.details[0].stage, "finance_confirm");
  assert.match(res.details[0].error, /coupon_codes_registry divergente/);
  assert.match(res.details[0].error, /item 0 divergente/);
  assert.equal(db.auditLogs.length, 0);
  assertLegacyIntact(db, "ev_001", "acct_1", ["CA", "CB"]);
});

test("21 — coupon_codes_registry com item a mais: bloqueia", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(1)] });
  tamperCreate(db, (data) => ({ ...data, coupon_codes_registry: ["CUPOM1", "EXTRA"] }));

  const res = await run(db, { eventId: "ev_001" });

  assert.equal(res.ok, false);
  assert.equal(res.details[0].stage, "finance_confirm");
  assert.match(res.details[0].error, /coupon_codes_registry divergente/);
  assert.match(res.details[0].error, /2 item\(ns\)|1 item\(ns\)/);
  assert.equal(db.auditLogs.length, 0);
  assertLegacyIntact(db, "ev_001", "acct_1");
});

test("22 — zero é valor: comissão 0 persiste como 0 e a migração conclui", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(1, { commission_percent: 0 })] });

  const res = await run(db, { eventId: "ev_001" });

  assert.equal(res.ok, true);
  assert.ok(res.details[0].fields.includes("commission_percent"), "zero conta como valor a migrar");
  assert.equal(db.finance("ev_001").commission_percent, 0, "zero gravado como zero");
  assert.equal(db.event("ev_001").commission_percent, null, "legado limpo");
});

test("23 — zero esperado contra campo vazio persistido: bloqueia (0 ≠ ausência)", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(1, { commission_percent: 0 })] });
  tamperCreate(db, (data) => ({ ...data, commission_percent: "" }));

  const res = await run(db, { eventId: "ev_001" });

  assert.equal(res.ok, false);
  assert.equal(res.details[0].stage, "finance_confirm");
  assert.match(res.details[0].error, /commission_percent divergente/);
  assert.match(res.details[0].error, /esperado número 0/);
  assert.equal(db.auditLogs.length, 0);
  assertLegacyIntact(db, "ev_001", "acct_1");
});

test("24 — escrita que altera valor já configurado é bloqueada (existente é a fonte da verdade)", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(1)], finances: [existingFinance()] });
  // O update "substitui" o documento em vez de completá-lo: o legado venceu indevidamente.
  tamperUpdate(db, (patch) => ({ ...patch, commission_percent: 10 }));

  const res = await run(db, { eventId: "ev_001" });

  assert.equal(res.ok, false);
  assert.equal(res.details[0].stage, "finance_confirm");
  assert.match(res.details[0].error, /commission_percent já configurado/);
  assert.equal(db.auditLogs.length, 0);
  assertLegacyIntact(db, "ev_001", "acct_1");
});

test("25 — reexecução após corrigir a divergência: conclui sem duplicidade", async () => {
  const db = createFakeEventDb({ events: [legacyEvent(1)] });
  const restore = tamperCreate(db, (data) => ({ ...data, commission_percent: 15 }));

  const blocked = await run(db, { eventId: "ev_001" });
  assert.equal(blocked.ok, false);
  assert.equal(db.auditLogs.length, 0, "nada de trilha de sucesso");
  assertLegacyIntact(db, "ev_001", "acct_1");

  // A divergência é corrigida no documento (caminho normal de gestão do evento).
  restore();
  db.finance("ev_001").commission_percent = 10;

  const retry = await run(db, { eventId: "ev_001" });

  assert.equal(retry.ok, true);
  assert.equal(retry.created, 0, "documento não é recriado");
  assert.equal(retry.cleared_only, 1);
  assert.equal(db.finances.length, 1, "sem documento duplicado");
  assert.equal(db.auditLogs.length, 1, "uma única trilha");
  assert.equal(db.finance("ev_001").commission_percent, 10);
  assert.equal(db.event("ev_001").payout_account_id, "", "legado limpo na reexecução");
  assert.equal(db.event("ev_001").commission_percent, null);
});