// F3-12 (2026-11-12) — neutralização de CSV/formula injection nas exportações.
//
// Nomes, e-mails, cupons e textos livres vêm de participantes/parceiros e vão
// para CSV aberto no Excel/Sheets do organizador. Célula iniciada por = + @ TAB
// ou CR é executada como FÓRMULA pela planilha (OWASP: CSV Injection); aspas
// NÃO neutralizam. Prefixar um apóstrofo mantém o texto visível e inerte.
//
// Exceção deliberada: '-' seguido de número puro (ex.: "-12,50") é valor
// monetário legítimo e permanece numérico — só o '-' que NÃO forma número é
// neutralizado (ex.: "-2+3+cmd|' /C calc'!A0").
const RISKY_PREFIX = /^[=+@\t\r]/;
const NUMERIC = /^-?\d+(?:[.,]\d+)?$/;

export function csvCell(value) {
  let s = String(value ?? "");
  if (RISKY_PREFIX.test(s) || (s.startsWith("-") && !NUMERIC.test(s))) s = "'" + s;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default csvCell;