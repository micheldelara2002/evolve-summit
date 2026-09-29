// PERF-001 — Varredura/paginação completa SEM truncagem silenciosa.
//
// MECANISMO (corrigido em 2026-09-29): a plataforma NÃO suporta range query nem
// em created_date (built-in) nem no campo reservado `id` — `id: { $lt / $gt }`
// retornam 0 registros (verificado na base real; range em campos normais
// funciona). Um cursor por id trunca SILENCIOSAMENTE na primeira página
// reportando complete=true — exatamente o bug que este módulo existia para
// eliminar. O mecanismo disponível é skip+limit com ordenação determinística
// por id.
//
// Skip = paginação funcional, NÃO cursor transacional: sob mutação
// concorrente a fotografia é EVENTUALMENTE CONSISTENTE (possível dupla-
// contagem ou omissão de poucos registros na borda). As redes de correção
// são os reconcilers (reconcileBusinessMetrics/reconcileGlobalMetrics).
//
// Tudo que era carregado com limite silencioso (10000/20000) e agregado em
// memória usa scanAll/countAll: as respostas informam consultas executadas e
// completude — qualquer teto é EXPLÍCITO, nunca silencioso.
//
// scanBatches (P2 2026-09-29): streaming por lote para jobs O(batch) —
// consolida os loops `while(true) skip+=BATCH` copiados pelas funções backend.
// Sem teto por padrão (paridade com os loops que substitui).

export const SCAN_PAGE_SIZE = 500;
export const SCAN_MAX_PAGES = 200; // 100.000 registros por varredura — teto EXPLÍCITO

// Varredura completa: carrega TODOS os registros do filtro em páginas (skip).
export async function scanAll(entity: any, baseQuery: any, opts: any = {}): Promise<{ items: any[]; queries: number; complete: boolean }> {
  const pageSize = Number(opts.pageSize) || SCAN_PAGE_SIZE;
  const maxPages = Number(opts.maxPages) || SCAN_MAX_PAGES;
  const sort = opts.sort || '-id';
  const items: any[] = [];
  let skip = 0;
  for (let i = 0; i < maxPages; i++) {
    const page = await entity.filter(baseQuery, sort, pageSize, skip);
    items.push(...page);
    if (page.length < pageSize) return { items, queries: i + 1, complete: true };
    skip += pageSize;
  }
  return { items, queries: maxPages, complete: false }; // teto atingido — sinalizado
}

// Uma página para endpoints com paginação backend obrigatória.
// cursor: undefined/null → primeira página; '' (string vazia) → fluxo
// encerrado (página vazia, sem refetch); caso contrário → token de OFFSET
// (string numérica) devolvido por esta função na página anterior. Tokens
// opacos para os callers (frontend devolve nextCursor sem interpretar);
// tokens legados (id) degradam de forma graciosa para a primeira página.
export async function fetchPage(entity: any, baseQuery: any, cursor: any, pageSize: number): Promise<{ page: any[]; nextCursor: string | null; hasMore: boolean }> {
  if (cursor === '') return { page: [], nextCursor: null, hasMore: false };
  const skip = Number(cursor) || 0;
  const page = await entity.filter(baseQuery, '-id', pageSize, skip);
  if (page.length < pageSize) return { page, nextCursor: null, hasMore: false };
  return { page, nextCursor: String(skip + pageSize), hasMore: true };
}

// Contagem EXATA de registros do filtro (varredura skip por páginas, sem
// retenção em memória) — usada para `total` nos endpoints paginados.
export async function countAll(entity: any, baseQuery: any, opts: any = {}): Promise<{ total: number; queries: number; complete: boolean }> {
  const pageSize = Number(opts.pageSize) || SCAN_PAGE_SIZE;
  const maxPages = Number(opts.maxPages) || SCAN_MAX_PAGES;
  let total = 0;
  let skip = 0;
  for (let i = 0; i < maxPages; i++) {
    const page = await entity.filter(baseQuery, '-id', pageSize, skip);
    total += page.length;
    if (page.length < pageSize) return { total, queries: i + 1, complete: true };
    skip += pageSize;
  }
  return { total, queries: maxPages, complete: false };
}

// Streaming por lote: processa cada página SEM acumular tudo em memória —
// jobs O(batch) (backfills, anonimização, agregação por lote, resolução de
// audiências). Skip-based, ordenação determinística por id (default '-id').
// maxPages: sem teto por padrão — o caller pode impor um explícito.
export async function* scanBatches(entity: any, baseQuery: any, opts: any = {}): AsyncGenerator<any[]> {
  const pageSize = Number(opts.pageSize) || SCAN_PAGE_SIZE;
  const sort = opts.sort || '-id';
  const maxPages = opts.maxPages ?? Infinity;
  let skip = 0;
  for (let i = 0; i < maxPages; i++) {
    const batch = await entity.filter(baseQuery, sort, pageSize, skip);
    if (!batch || batch.length === 0) return;
    yield batch;
    if (batch.length < pageSize) return;
    skip += pageSize;
  }
}