// F3-12/F3-14 (2026-11-12) — regressão de CSV/Formula Injection nas exportações.
// A célula é gerada por src/lib/csvSafe.js e usada por salesExport (relatório de
// vendas) e pela exportação da aba Pessoas — as duas passam por csvCell.
import test from "node:test";
import assert from "node:assert/strict";
import { csvCell, csvRow } from "../../src/lib/csvSafe.js";

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
  // A vírgula não força aspas: é o separador da exportação de Pessoas e o
  // decimal pt-BR ("-12,50") precisa continuar numérico.
  assert.equal(csvCell("a,b"), "a,b");
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

test("CSV-6 — prefixo por tabulação, CR e LF", () => {
  assert.equal(csvCell("\t=1+1"), "'\t=1+1");
  // CR e LF obrigam aspas, mas o apóstrofo vem antes.
  assert.equal(csvCell("\r=1+1"), "\"'\r=1+1\"");
  assert.equal(csvCell("\n@SUM(A1)"), "\"'\n@SUM(A1)\"");
  assert.equal(csvCell("\t-2+3"), "'\t-2+3");
});

test("CSV-7 — espaços e caracteres de controle antes do perigo", () => {
  assert.equal(csvCell("   =cmd"), "'   =cmd");
  assert.equal(csvCell("\u0000+\tcmd"), "'\u0000+\tcmd");
  // Texto legítimo com espaço inicial permanece texto legítimo.
  assert.equal(csvCell("  Maria"), "  Maria");
});

test("CSV-8 — sinais de fórmula em posições não iniciais são texto normal", () => {
  assert.equal(csvCell("a=b"), "a=b");
  assert.equal(csvCell("total + 3"), "total + 3");
  assert.equal(csvCell("e-mail@dominio.com"), "e-mail@dominio.com");
});

test("CSV-9 — payload com delimitadores, aspas e fórmula", () => {
  const cell = csvCell('=HYPERLINK("http://x","clique";A1)');
  assert.ok(cell.startsWith("\"'="), "prefixo inerte antes das aspas");
  assert.ok(cell.endsWith('"'));
  assert.ok(cell.includes('""http://x""'), "aspas internas duplicadas");
});

test("CSV-10 — telefone com + permanece visível, porém inerte", () => {
  assert.equal(csvCell("+5511999999999"), "'+5511999999999");
});

test("CSV-11 — linha completa (exportações Pessoas e Vendas usam csvCell por célula)", () => {
  assert.equal(
    csvRow(["Maria", "=cmd", "-12,50"]),
    "Maria;'=cmd;-12,50",
  );
});

test("CSV-12 — data e valores numéricos formatados não ganham prefixo", () => {
  assert.equal(csvCell("12/11/2026 21:17:00"), "12/11/2026 21:17:00");
  assert.equal(csvCell("129,90"), "129,90");
  assert.equal(csvCell("paid"), "paid");
});