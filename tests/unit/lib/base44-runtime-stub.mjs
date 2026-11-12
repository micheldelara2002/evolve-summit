// Stub do módulo de runtime do Deno (`base44:runtime`) para os testes de Node.
//
// `base44/shared/commerceFulfillment.ts` importa esse módulo indiretamente (via
// stripeClient.ts, que lê segredos do Stripe). Os testes exercitam APENAS os
// caminhos locais de estorno — nenhuma chamada HTTP ao Stripe acontece — então
// o stub existe só para permitir a resolução do import, sem simular rede.
export const secrets = {
  get: async () => undefined,
  getSecret: async () => undefined,
};

export default { secrets };