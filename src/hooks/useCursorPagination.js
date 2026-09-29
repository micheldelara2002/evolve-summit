import { useState, useEffect, useCallback } from "react";

const DEFAULT_PAGE_SIZE = 50;

/**
 * Paginação encadeada por skip em lista ordenada por `-id` (ordem total
 * determinística — janelas estáveis).
 *
 * IMPORTANTE (corrigido 2026-09-29): a plataforma NÃO suporta range query no
 * campo reservado `id` (`{ id: { $lt } }` retorna 0 registros) — o cursor por
 * id silenciosamente truncava na primeira página. O mecanismo disponível é
 * skip+limit: o hook rastreia o offset internamente e o expõe ao fetchPage.
 *
 * Ordenação de exibição (ex.: por created_date) é responsabilidade do
 * consumidor, client-side, após carregar os itens.
 *
 * @param {Object} opts
 * @param {Function} opts.fetchPage - async (query, sort, limit, skip) => Array de registros
 * @param {Object} opts.baseQuery - filtro base aplicado a todas as páginas
 * @param {string} opts.depsKey - string key; pagination resets when this changes
 * @param {number} [opts.pageSize=50]
 * @param {boolean} [opts.enabled=true] - when false, items are cleared and no fetching occurs
 * @returns {{ items: Array, loading: boolean, hasMore: boolean, loadMore: Function }}
 */
export function useCursorPagination({ fetchPage, baseQuery, depsKey, pageSize = DEFAULT_PAGE_SIZE, enabled = true }) {
  const [items, setItems] = useState([]);
  const [skip, setSkip] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  const baseQueryKey = JSON.stringify(baseQuery);

  const loadFirstPage = useCallback(async () => {
    if (!enabled) {
      setItems([]);
      setHasMore(false);
      setSkip(0);
      return;
    }
    setLoading(true);
    try {
      const page = await fetchPage(baseQuery, "-id", pageSize, 0);
      setItems(page);
      if (page.length < pageSize) {
        setHasMore(false);
        setSkip(0);
      } else {
        setSkip(pageSize);
        setHasMore(true);
      }
    } finally {
      setLoading(false);
    }
  }, [enabled, depsKey, baseQueryKey, fetchPage, pageSize]);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    setLoading(true);
    try {
      const page = await fetchPage(baseQuery, "-id", pageSize, skip);
      setItems((prev) => [...prev, ...page]);
      if (page.length < pageSize) {
        setHasMore(false);
      } else {
        setSkip(skip + pageSize);
      }
    } finally {
      setLoading(false);
    }
  }, [hasMore, loading, skip, baseQueryKey, fetchPage, pageSize]);

  return { items, loading, hasMore, loadMore };
}