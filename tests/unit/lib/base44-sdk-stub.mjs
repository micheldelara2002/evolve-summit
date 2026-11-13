// Stub do SDK `npm:@base44/sdk` para os testes de caminho HTTP das funções
// backend (entry.ts) rodando no Node.
//
// O teste injeta o cliente falso em `globalThis.__base44ClientFromRequest`
// antes de chamar a função. Não há rede, não há banco real: o cliente falso
// implementa apenas as operações de entidade que o fluxo exercita.
export function createClientFromRequest(req) {
  const factory = globalThis.__base44ClientFromRequest;
  if (typeof factory !== "function") {
    throw new Error("Nenhum cliente Base44 configurado para este teste (globalThis.__base44ClientFromRequest).");
  }
  return factory(req);
}

export default { createClientFromRequest };