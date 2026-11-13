// F3-12/F3-14 (2026-11-12) — neutralização de CSV/formula injection.
//
// Nomes, e-mails, cupons, observações e textos livres vêm de participantes,
// compradores e parceiros e vão para um CSV aberto no Excel/LibreOffice/Sheets
// do organizador. Célula iniciada por `=`, `+`, `-`, `@` (ou pelo mesmo caractere
// depois de tabulação/CR/LF/espaços/caracteres de controle) é executada como
// FÓRMULA pela planilha (OWASP: CSV Injection) — aspas NÃO neutralizam.
// Prefixar um apóstrofo mantém o texto visível e inerte.
//
// Exceção deliberada: número legítimo (inclusive negativo, ex.: "-12,50" ou
// "+3") permanece numérico — só o sinal que NÃO forma número é neutralizado
// (ex.: "-2+3+cmd|' /C calc'!A0").
//
// Toda exportação do app passa por aqui (Pessoas e Vendas). Exportação nova deve
// usar estas funções, nunca montar a linha à mão.

// Só o sinal negativo numérico é preservado ("-12,50"). "+" nunca é preservado:
// planilhas tratam "+..." como fórmula (e telefone com "+55..." é texto).
const NEGATIVE_NUMBER = /^-\d+(?:[.,]\d+)?$/;
// Espaços e caracteres de controle no início (TAB, CR, LF, NUL…).
const LEADING_INERT = /^[\s\u0000-\u001F\u007F]+/;
// Controle no INÍCIO (TAB, CR, LF, NUL…) é vetor por si: a planilha descarta o
// caractere e trata o resto como fórmula. Espaço não é controle.
const LEADING_CONTROL = /^[\u0000-\u001F\u007F]/;
const FORMULA_START = /^[=+\-@]/;
// Separador do arquivo e quebras exigem aspas (aspas duplas são duplicadas).
// A vírgula NÃO entra: a exportação de Pessoas usa ',' como separador e valores
// monetários pt-BR ("-12,50") já são válidos sem aspas.
const NEEDS_QUOTE = /["\n\r;]/;

export function csvCell(value) {
  let s = String(value ?? "");
  const significant = s.replace(LEADING_INERT, "");
  const startsFormula = FORMULA_START.test(significant);
  const isNegativeNumber = NEGATIVE_NUMBER.test(significant);

  // Neutraliza o que a planilha interpretaria: sinal de fórmula no primeiro
  // caractere significativo (inclusive depois de espaços) ou controle no início.
  if ((startsFormula && !isNegativeNumber) || LEADING_CONTROL.test(s)) s = "'" + s;

  return NEEDS_QUOTE.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Monta uma linha CSV com as células já neutralizadas. */
export function csvRow(values) {
  return values.map(csvCell).join(";");
}

export default csvCell;