// P2 (2026-09-29) — Fonte única da ordenação canônica do par de person_ids
// (chave de unicidade de Connection e ChatThread: sempre [menor, maior]).
// Era copiado idêntico em manageConnection e getOrCreateThread.

export function sortPersonIds(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}