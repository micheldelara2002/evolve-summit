// F3-12 (2026-11-12) — regressão de CSV/Formula Injection nas exportações.
// A célula é gerada por src/lib/csvSafe.js e usada por salesExport (relatório
// de vendas) e pela exportação da aba Pessoas.
import test from "node:test";
import assert from "node:assert/strict";
import { csvCell } from "../../src/lib/csvSafe.js";

test("CSV-1 — prefixos de fórmula são neutralizados", () => {
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("\tcmd"), "'\tcmd");
  assert.equal(csvCell("-2+3+cmd|' /C calc'!A0"), "'-2+3+cmd|' /C calc'!A0");
});

test("CSV-2 — valores monetários negativos continuam numéricos", () => {
  assert.equal(csvCell("-12,50"), "-12,50");
  assert.equal(csvCell("-1234"), "-1234");
  assert.equal(csvCell("0,00"), "0,00");
});

test("CSV-3 — texto legítimo e aspas preservados", () => {
  assert.equal(csvCell("Maria Silva"), "Maria Silva");
  assert.equal(csvCell('João "Jota" Silva'), '"João ""Jota"" Silva"');
  assert.equal(csvCell("a;b"), '"a;b"');
  assert.equal(csvCell("linha\nquebrada"), '"linha\nquebrada"');
});

test("CSV-4 — valor nulo/vazio não quebra a célula", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(0), "0");
});

test("CSV-5 — neutralização acontece ANTES do quoting", () => {
  // Célula com ';' e prefixo de fórmula: precisa ficar entre aspas E inerte.
  assert.equal(csvCell("=cmd;rm"), '"\'=cmd;rm"');
});