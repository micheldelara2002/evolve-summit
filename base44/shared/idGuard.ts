// Lote 4 — Validação de formato de ObjectIds recebidos do cliente.
// Filtros da plataforma lançam 500 com IDs malformados ('not a valid ObjectId');
// este guard descarta valores inválidos antes de qualquer query, devolvendo
// resultado vazio/404 limpo em vez de erro.

export function validIds(ids: any): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    if (!/^[a-f0-9]{24}$/i.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function isValidId(id: any): boolean {
  return typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
}