// P1.3 (patch Fase 1) — Paginação genérica de listas da API do Stripe.
//
// A lista de estornos de um PaymentIntent é paginada (has_more/starting_after).
// Assumir que a primeira página é suficiente levava a conclusões erradas
// ("não existe estorno anterior") e, no limite, a criar um estorno duplicado.
// Este módulo é puro (recebe a função de busca) para ser testável isoladamente:
// o stripeClient usa EXATAMENTE este laço.

export type PaginationResult<T> = { items: T[]; complete: boolean; pages: number };

// `fetchPage(cursor)` devolve os itens da página e se há mais páginas.
// Erros são propagados (o chamador trata como resultado INCONCLUSIVO).
// `complete = false` quando o limite operacional de páginas é atingido com mais
// páginas pendentes — ausência de item NÃO pode ser afirmada nesse caso.
export async function collectPages<T>(
  fetchPage: (cursor: string) => Promise<{ items: T[]; hasMore: boolean }>,
  opts?: { maxPages?: number },
): Promise<PaginationResult<T>> {
  const maxPages = Math.max(1, Math.min(Number(opts?.maxPages) || 5, 20));
  const items: T[] = [];
  let cursor = "";
  let pages = 0;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(cursor);
    pages++;
    const batch = Array.isArray(result?.items) ? result.items : [];
    items.push(...batch);
    if (!result?.hasMore || batch.length === 0) return { items, complete: true, pages };
    if (page === maxPages - 1) return { items, complete: false, pages };
    cursor = String((batch[batch.length - 1] as any)?.id || "");
    if (!cursor) return { items, complete: false, pages };
  }
  return { items, complete: false, pages };
}