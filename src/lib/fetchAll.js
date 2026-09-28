/**
 * Varredura completa paginada de uma entidade via SDK (limit+skip em loop).
 *
 * P2 (auditoria 2026-09-28) — o filtro sem limite devolve no máximo o default
 * da plataforma, truncando silenciosamente listas grandes (ex.: histórico de
 * certificados). Este helper encadeia páginas até esgotar o conjunto.
 *
 * @param {Function} filterFn - (query, sort, limit, skip) => Array (SDK filter)
 * @param {Object} baseQuery - filtro base aplicado a todas as páginas
 * @param {string} [sort="-created_date"] - ordenação estável
 * @param {number} [batchSize=500] - tamanho da página
 */
export async function scanAllRecords(filterFn, baseQuery = {}, sort = "-created_date", batchSize = 500) {
  const all = [];
  let skip = 0;
  while (true) {
    const page = await filterFn(baseQuery, sort, batchSize, skip);
    all.push(...(page || []));
    if (!page || page.length < batchSize) break;
    skip += batchSize;
  }
  return all;
}