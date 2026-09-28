// =============================================================================
// P3 (auditoria 2026-09-28) — Tiebreaker determinístico consolidado.
//
// Padrão "sobrevivente determinístico" usado em TODA dedup concorrente do app
// (resgates, pontuação, certificados, threads, checkout): quando dois requests
// concorrentes criam registros duplicados, ambos os lados da corrida devem
// eleger EXATAMENTE O MESMO sobrevivente — ordenação estável por
// (created_date, id). Sem o desempate por id, dois requests podem discordar
// (ambos deletam o registro do outro / ambos se declaram sobreviventes).
// =============================================================================

export function deterministicCompare(a: any, b: any): number {
  const dc = new Date(a.created_date).getTime() - new Date(b.created_date).getTime();
  return dc !== 0 ? dc : (a.id < b.id ? -1 : 1);
}