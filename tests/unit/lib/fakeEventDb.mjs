// Fake mínimo para os testes da migração EventFinance.
//
// Reproduz o que o código de produção usa:
//   • `filter(query)`            → array (sem opções), como o SDK;
//   • `filter(query, options)`   → página { items, next_cursor, has_more },
//                                  com cursor keyset ("cur:<id>") e limite —
//                                  é o que permite testar paginação real;
//   • `create` / `update` / `updateMany` / `delete`.
//
// O cursor do fake é proposital: só avança se o chamador devolver exatamente o
// valor recebido. Um cursor inventado ou reutilizado errado aparece no teste.
//
// NÃO modela: concorrência real, transações entre coleções, latência.

function matchesValue(actual, cond) {
  if (cond === undefined) return true;
  if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
    if ("$exists" in cond) return cond.$exists ? actual !== undefined : actual === undefined;
    if ("$lte" in cond) return actual !== undefined && actual !== null && actual <= cond.$lte;
    if ("$gte" in cond) return actual !== undefined && actual !== null && actual >= cond.$gte;
    if ("$lt" in cond) return actual !== undefined && actual !== null && actual < cond.$lt;
    if ("$gt" in cond) return actual !== undefined && actual !== null && actual > cond.$gt;
    if ("$ne" in cond) return Array.isArray(actual) ? !actual.includes(cond.$ne) : actual !== cond.$ne;
    if ("$in" in cond) return Array.isArray(actual) ? cond.$in.some((v) => actual.includes(v)) : cond.$in.includes(actual);
    if ("$nin" in cond) return Array.isArray(actual) ? !cond.$nin.some((v) => actual.includes(v)) : !cond.$nin.includes(actual);
    return JSON.stringify(actual) === JSON.stringify(cond);
  }
  if (Array.isArray(actual)) return actual.some((x) => x === cond);
  return actual === cond;
}

function matches(doc, query) {
  for (const [key, cond] of Object.entries(query || {})) {
    if (key === "$or") {
      if (!cond.some((q) => matches(doc, q))) return false;
      continue;
    }
    if (key === "$and") {
      if (!cond.every((q) => matches(doc, q))) return false;
      continue;
    }
    if (!matchesValue(doc[key], cond)) return false;
  }
  return true;
}

function applyUpdate(doc, update) {
  for (const [op, payload] of Object.entries(update)) {
    if (op === "$set") Object.assign(doc, payload);
    else if (op === "$inc") {
      for (const [k, v] of Object.entries(payload)) doc[k] = (Number(doc[k]) || 0) + v;
    } else if (op === "$push") {
      for (const [k, v] of Object.entries(payload)) {
        if (!Array.isArray(doc[k])) doc[k] = [];
        doc[k].push(v);
      }
    } else if (op === "$addToSet") {
      for (const [k, v] of Object.entries(payload)) {
        if (!Array.isArray(doc[k])) doc[k] = [];
        if (!doc[k].includes(v)) doc[k].push(v);
      }
    } else if (op === "$pull") {
      for (const [k, v] of Object.entries(payload)) {
        if (Array.isArray(doc[k])) doc[k] = doc[k].filter((x) => x !== v);
      }
    } else {
      throw new Error(`fakeEventDb: operador não suportado (${op})`);
    }
  }
}

// Ordem estável da paginação: created_date e, no empate, id.
function sortDocs(rows) {
  return [...rows].sort((a, b) => {
    const ca = String(a.created_date || "");
    const cb = String(b.created_date || "");
    if (ca !== cb) return ca < cb ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : 1;
  });
}

export function createFakeEventDb({ events = [], finances = [], auditLogs = [] } = {}) {
  const eventRows = events.map((r) => ({ ...r }));
  const financeRows = finances.map((r) => ({ ...r }));
  const auditRows = auditLogs.map((r) => ({ ...r }));
  let seq = 0;

  function collection(rows, { paged = false, prefix = "row" } = {}) {
    return {
      async filter(query = {}, options) {
        const matched = sortDocs(rows.filter((d) => matches(d, query)));
        const wantsPage = paged && options && typeof options === "object";
        if (!wantsPage) return matched.map((d) => ({ ...d }));

        const limit = Math.max(1, Math.min(Number(options.limit) || matched.length, matched.length));
        let start = 0;
        if (options.cursor) {
          const key = String(options.cursor).replace(/^cur:/, "");
          const idx = matched.findIndex((d) => d.id === key);
          start = idx >= 0 ? idx + 1 : 0;
        }
        const slice = matched.slice(start, start + limit);
        const hasMore = start + slice.length < matched.length;
        return {
          items: slice.map((d) => ({ ...d })),
          next_cursor: hasMore ? `cur:${slice[slice.length - 1].id}` : null,
          has_more: hasMore,
        };
      },
      async create(data) {
        const row = { id: `${prefix}_${++seq}`, ...data };
        rows.push(row);
        return { ...row };
      },
      async update(id, patch) {
        const doc = rows.find((d) => d.id === id);
        if (!doc) return null;
        Object.assign(doc, patch);
        return { ...doc };
      },
      async updateMany(query, update) {
        const targets = rows.filter((d) => matches(d, query));
        for (const d of targets) applyUpdate(d, update);
        return { updated: targets.length };
      },
      async delete(id) {
        const idx = rows.findIndex((d) => d.id === id);
        if (idx < 0) return { deleted: 0 };
        rows.splice(idx, 1);
        return { deleted: 1 };
      },
    };
  }

  const svc = {
    entities: {
      Event: collection(eventRows, { paged: true, prefix: "ev" }),
      EventFinance: collection(financeRows, { prefix: "fin" }),
      AuditLog: collection(auditRows, { prefix: "aud" }),
    },
  };

  return {
    svc,
    events: eventRows,
    finances: financeRows,
    auditLogs: auditRows,
    event: (id) => eventRows.find((e) => e.id === id),
    finance: (eventId) => financeRows.find((f) => f.event_id === eventId),
    auditByKey: (key) => auditRows.filter((a) => a.audit_key === key),
  };
}

// Evento legado típico: campos financeiros ainda no Event.
export function legacyEvent(index, over = {}) {
  const day = String((index % 27) + 1).padStart(2, "0");
  return {
    id: `ev_${String(index).padStart(3, "0")}`,
    name: `Evento ${index}`,
    status: "active",
    is_deleted: false,
    created_date: `2026-01-${day}T10:00:00.000Z`,
    commission_percent: 10,
    payout_account_id: `acct_${index}`,
    refund_policy: JSON.stringify({ full_refund_until_days: 7 }),
    coupon_codes_registry: [`CUPOM${index}`],
    ...over,
  };
}