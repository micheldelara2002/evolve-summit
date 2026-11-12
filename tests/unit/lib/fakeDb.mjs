// Fake mínimo do banco para os testes do ledger de estorno.
//
// Implementa APENAS os operadores usados pelo código de produção, com a MESMA
// semântica do banco real: `updateMany(query, update)` aplica a atualização
// somente nos documentos que casam o filtro, no mesmo instante (uma escrita
// atômica por documento). Isso permite testar as corridas de verdade — duas
// chamadas concorrentes com estado lido antes da escrita.

function matchesValue(actual, cond) {
  if (cond === undefined) return true;
  if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
    if ("$exists" in cond) return cond.$exists ? actual !== undefined : actual === undefined;
    if ("$lte" in cond) return actual !== undefined && actual !== null && actual <= cond.$lte;
    if ("$gte" in cond) return actual !== undefined && actual !== null && actual >= cond.$gte;
    if ("$lt" in cond) return actual !== undefined && actual !== null && actual < cond.$lt;
    if ("$gt" in cond) return actual !== undefined && actual !== null && actual > cond.$gt;
    // Semântica do banco real: em campo array, $ne casa quando o array NÃO
    // contém o valor; $in casa quando contém algum dos valores.
    if ("$ne" in cond) return Array.isArray(actual) ? !actual.includes(cond.$ne) : actual !== cond.$ne;
    if ("$in" in cond) return Array.isArray(actual) ? cond.$in.some((v) => actual.includes(v)) : cond.$in.includes(actual);
    if ("$nin" in cond) return Array.isArray(actual) ? !cond.$nin.some((v) => actual.includes(v)) : !cond.$nin.includes(actual);
    return JSON.stringify(actual) === JSON.stringify(cond);
  }
  // Igualdade escalar contra campo array = "contém" (igual ao banco real).
  if (Array.isArray(actual)) return actual.some((x) => x === cond);
  return actual === cond;
}

function matches(doc, query) {
  for (const [key, cond] of Object.entries(query)) {
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
    if (op === "$set") {
      Object.assign(doc, payload);
    } else if (op === "$inc") {
      for (const [k, v] of Object.entries(payload)) doc[k] = (Number(doc[k]) || 0) + v;
    } else if (op === "$push") {
      for (const [k, v] of Object.entries(payload)) {
        if (!Array.isArray(doc[k])) doc[k] = [];
        doc[k].push(v);
      }
    } else if (op === "$pull") {
      for (const [k, v] of Object.entries(payload)) {
        if (Array.isArray(doc[k])) doc[k] = doc[k].filter((x) => x !== v);
      }
    } else {
      throw new Error(`fakeDb: operador não suportado (${op})`);
    }
  }
}

function collection(rows) {
  return {
    async filter(query = {}) {
      return rows.filter((d) => matches(d, query)).map((d) => ({ ...d }));
    },
    async updateMany(query, update) {
      const targets = rows.filter((d) => matches(d, query));
      for (const d of targets) applyUpdate(d, update);
      return { updated: targets.length };
    },
    async update(id, patch) {
      const d = rows.find((x) => x.id === id);
      if (!d) return null;
      Object.assign(d, patch);
      return { ...d };
    },
    async create(data) {
      const row = { id: `gen_${rows.length + 1}`, ...data };
      rows.push(row);
      return { ...row };
    },
  };
}

export function createFakeDb({ payments = [], refundRequests = [] } = {}) {
  const paymentRows = payments.map((p) => ({ ...p }));
  const refundRows = refundRequests.map((r) => ({ ...r }));
  const svc = {
    entities: {
      Payment: collection(paymentRows),
      RefundRequest: collection(refundRows),
    },
  };
  return {
    svc,
    payments: paymentRows,
    refundRequests: refundRows,
    payment: (id) => paymentRows.find((p) => p.id === id),
  };
}

export function basePayment(over = {}) {
  return {
    id: "pay_1",
    order_id: "ord_1",
    event_id: "ev_1",
    intent_id: "pi_1",
    amount: 100,
    amount_cents: 10000,
    currency: "BRL",
    status: "succeeded",
    refunded_amount: 0,
    ...over,
  };
}