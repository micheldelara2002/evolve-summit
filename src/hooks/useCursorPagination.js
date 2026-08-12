import { useState, useEffect, useCallback } from "react";

const DEFAULT_PAGE_SIZE = 50;

/**
 * Deterministic cursor-based pagination using `id` as the sole sort+cursor key.
 *
 * Base44 SDK supports single-field sort only (no compound ordering such as
 * (created_date, id)). Since `id` is unique, sorting by -id gives a total order
 * with no ties — pages never duplicate or skip items. Display ordering (e.g. by
 * created_date) is handled client-side by the consumer after items are loaded.
 *
 * The cursor is the id of the last item on the current page.
 * The next page query merges `{ id: { $lt: cursor.id } }` into the base query.
 *
 * @param {Object} opts
 * @param {Function} opts.fetchPage - async (query, sort, limit) => Array of records
 * @param {Object} opts.baseQuery - base filter applied to every page query
 * @param {string} opts.depsKey - string key; pagination resets when this changes
 * @param {number} [opts.pageSize=50]
 * @param {boolean} [opts.enabled=true] - when false, items are cleared and no fetching occurs
 * @returns {{ items: Array, loading: boolean, hasMore: boolean, loadMore: Function }}
 */
export function useCursorPagination({ fetchPage, baseQuery, depsKey, pageSize = DEFAULT_PAGE_SIZE, enabled = true }) {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  const baseQueryKey = JSON.stringify(baseQuery);

  const buildQuery = useCallback(
    (cur) => {
      if (!cur) return baseQuery;
      return {
        ...baseQuery,
        id: { $lt: cur.id },
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseQueryKey]
  );

  const loadFirstPage = useCallback(async () => {
    if (!enabled) {
      setItems([]);
      setHasMore(false);
      setCursor(null);
      return;
    }
    setLoading(true);
    try {
      const page = await fetchPage(buildQuery(null), "-id", pageSize);
      setItems(page);
      if (page.length < pageSize) {
        setHasMore(false);
        setCursor(null);
      } else {
        const last = page[page.length - 1];
        setCursor({ id: last.id });
        setHasMore(true);
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, depsKey, buildQuery]);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!hasMore || loading || !cursor) return;
    setLoading(true);
    try {
      const page = await fetchPage(buildQuery(cursor), "-id", pageSize);
      setItems((prev) => [...prev, ...page]);
      if (page.length < pageSize) {
        setHasMore(false);
        setCursor(null);
      } else {
        const last = page[page.length - 1];
        setCursor({ id: last.id });
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, loading, cursor, buildQuery]);

  return { items, loading, hasMore, loadMore };
}