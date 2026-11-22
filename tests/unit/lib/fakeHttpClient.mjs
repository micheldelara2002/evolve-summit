// Cliente falso para os testes de CAMINHO HTTP das funções backend.
//
// As funções recebem `createClientFromRequest(req)`; o stub do SDK injeta o
// cliente daqui. Cada teste descreve as coleções que o fluxo usa e os pontos de
// falha (faults) que quer exercitar — nenhuma rede, nenhum banco real.

import { collection } from "./fakeDb.mjs";

const COMMON = [
  "User",
  "Event",
  "EventFinance",
  "PayoutAccount",
  "PlatformSetting",
  "AuditLog",
  "EventMembership",
  "AwardConfig",
  "AwardSubmission",
  "AwardEvaluation",
  "Person",
  "EventInvite",
];

// Envolve a coleção do fakeDb com injeção de falha por operação.
export function makeEntity(name, rows, faults = {}) {
  const base = collection(rows);
  const guard = (op) => {
    if (faults[`${name}.${op}`]) throw new Error(`${name} indisponível (${op})`);
  };
  return {
    async filter(query = {}, ...rest) {
      guard("filter");
      return base.filter(query, ...rest);
    },
    async updateMany(query, update) {
      guard("updateMany");
      return base.updateMany(query, update);
    },
    async update(id, patch) {
      guard("update");
      return base.update(id, patch);
    },
    async create(data = {}) {
      guard("create");
      return base.create(data);
    },
    async delete(id) {
      guard("delete");
      return base.delete(id);
    },
  };
}

export function makeHttpClient({ user, collections = {}, faults = {} }) {
  const rows = {};
  const entities = {};
  const names = new Set([...COMMON, ...Object.keys(collections)]);
  for (const name of names) {
    rows[name] = collections[name] || [];
    entities[name] = makeEntity(name, rows[name], faults);
  }
  const base44 = {
    auth: { me: async () => user },
    asServiceRole: { entities },
    entities,
  };
  return { base44, rows, entities };
}

export function makeReq(body = {}) {
  return {
    json: async () => body,
    headers: new Headers(),
  };
}

// Invoca a função com o cliente injetado e devolve status + corpo já lidos.
export async function invoke(fn, base44, body = {}) {
  globalThis.__base44ClientFromRequest = () => base44;
  const res = await fn(makeReq(body));
  const data = await res.json();
  return { status: res.status, data };
}