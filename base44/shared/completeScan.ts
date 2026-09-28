// PERF-001 — Varredura/paginação completa SEM truncagem silenciosa.
//
// A plataforma não suporta range query em created_date (só equality em chaves
// de dia) nem projeção de campos; a ordem total determinística disponível é
// por `id` (único): sort '-id' + cursor { id: { $lt: cursor } } — páginas
// nunca duplicam nem omitem registros (mesma primitiva do hook
// useCursorPagination, executada no backend).
//
// Tudo que era carregado com limite silencioso (10000/20000) e agregado em
// memória agora usa estas funções: as respostas informam consultas executadas
// e completude — qualquer teto é EXPLÍCITO, nunca silencioso.

export const SCAN_PAGE_SIZE = 500;
export const SCAN_MAX_PAGES = 200; // 100.000 registros por varredura — teto EXPLÍCITO

// Varredura completa: carrega TODOS os registros do filtro em páginas.
export async function scanAll(entity: any, baseQuery: any, opts: any = {}): Promise<{ items: any[]; queries: number; complete: boolean }> {
  const pageSize = Number(opts.pageSize) || SCAN_PAGE_SIZE;
  const maxPages = Number(opts.maxPages) || SCAN_MAX_PAGES;
  const items: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const query = cursor ? { ...baseQuery, id: { $lt: cursor } } : baseQuery;
    const page = await entity.filter(query, '-id', pageSize);
    items.push(...page);
    if (page.length < pageSize) return { items, queries: i + 1, complete: true };
    cursor = page[page.length - 1].id;
  }
  return { items, queries: maxPages, complete: false }; // teto atingido — sinalizado
}

// Uma página para endpoints com paginação backend obrigatória.
// cursor: undefined/null → primeira página; '' (string vazia) → fluxo
// encerrado (página vazia, sem refetch); caso contrário → id do último item.
export async function fetchPage(entity: any, baseQuery: any, cursor: any, pageSize: number): Promise<{ page: any[]; nextCursor: string | null; hasMore: boolean }> {
  if (cursor === '') return { page: [], nextCursor: null, hasMore: false };
  const query = cursor ? { ...baseQuery, id: { $lt: cursor } } : baseQuery;
  const page = await entity.filter(query, '-id', pageSize);
  if (page.length < pageSize) return { page, nextCursor: null, hasMore: false };
  return { page, nextCursor: page[page.length - 1].id, hasMore: true };
}

// Contagem EXATA de registros do filtro (varredura por id sem retenção em
// memória) — usada para `total` nos endpoints paginados.
export async function countAll(entity: any, baseQuery: any, opts: any = {}): Promise<{ total: number; queries: number; complete: boolean }> {
  const pageSize = Number(opts.pageSize) || SCAN_PAGE_SIZE;
  const maxPages = Number(opts.maxPages) || SCAN_MAX_PAGES;
  let total = 0;
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const query = cursor ? { ...baseQuery, id: { $lt: cursor } } : baseQuery;
    const page = await entity.filter(query, '-id', pageSize);
    total += page.length;
    if (page.length < pageSize) return { total, queries: i + 1, complete: true };
    cursor = page[page.length - 1].id;
  }
  return { total, queries: maxPages, complete: false };
}