# Fase 2 — Estorno, trava e receita: lista fechada para correção em UM patch

**Data:** 2026-11-12
**Escopo:** tudo que ficou aberto no domínio do estorno depois do fechamento da Fase 1
(ledger atômico, correlação por identidade, devolução de estoque exatamente uma vez,
conclusão só com estado persistido).
**Origem:** revisão do código atual (`requestRefund`, `stripeWebhook`,
`expireStaleReservations`, `commerceFulfillment`, `refundLedger`, `refundGuards`,
`getEventSalesSummary`, `getSalesMetrics`).

> Este documento é a entrega completa da Fase 2. Os itens abaixo podem e devem ser
> corrigidos juntos — nenhum depende de decisão de negócio em aberto e nenhum exige
> refatoração ampla. Cada item traz evidência (arquivo:linha), impacto, correção
> exata e teste de aceite.

---

## 0. Regras que valem para todos os itens

1. **Não alterar** RLS, `provenance`, correlação por identidade (`associateRefundToRequest(s)`),
   paginação de estornos (`listRefundsForIntent`), mecanismo de CAS do estoque
   (`returnSoldQuantityOnce`) nem as regras comerciais da política de estorno.
2. **Não executar estornos reais.** Nenhum teste toca o Stripe.
3. **Não escrever dados de produção.** Testes usam o `fakeDb` (`tests/unit/lib/fakeDb.mjs`).
4. **Não publicar, não fazer deploy.** Patch de código + testes.
5. **Nada de fallback silencioso.** Estado duvidoso mantém a solicitação pendente e
   os ingressos travados; nunca libera ingresso por timeout.
6. **Falha de escrita é falha.** Nenhum caminho declara conclusão sem reler o estado.

### Portão de validação (o patch só é aceito assim)

```
npm run test:unit:refund     # suíte atual + novos testes desta fase
npm run build
npx eslint <arquivos .ts alterados>   # 0 erros
```

Rotina obrigatória: **mutação**. Reintroduzir o defeito, provar que o teste novo
falha, restaurar e provar que volta verde.

---

## F2-01 · P0 · Segundo estorno do mesmo pedido é impossível

**Evidência:** `base44/functions/requestRefund/entry.ts:63`

```ts
if (payment.status !== "succeeded") {
  return Response.json({ error: "Este pagamento não pode ser estornado (status atual: " + payment.status + ")." }, { status: 400 });
}
```

**Defeito:** o primeiro estorno confirmado grava `Payment.status = "partially_refunded"`
(ou `"refunded"`) em `commerceFulfillment.ts:550` e `:738`. A partir daí **nenhuma**
nova solicitação passa — nem `cancel_item` para outro ingresso do mesmo pedido, que é
exatamente o caso de uso do `cancel_item` (pedido com N ingressos, cada um com titular
diferente).

**Impacto:** fluxo de negócio quebrado. Gerente precisa editar o banco para cancelar o
segundo ingresso. A trava por documento funciona; o portão de elegibilidade é que
está errado, e ele contradiz o próprio ledger (que já sabe exatamente quanto ainda
pode ser devolvido).

**Correção exata:** substituir a condição por uma lista fechada de estados estornáveis
e manter o ledger como único portão de valor:

```ts
const REFUNDABLE_PAYMENT_STATUSES = ["succeeded", "partially_refunded"];
if (!REFUNDABLE_PAYMENT_STATUSES.includes(String(payment.status))) {
  return Response.json({ error: `Este pagamento não pode ser estornado (status atual: ${payment.status}).` }, { status: 400 });
}
```

O teto continua vindo de `availableRefundCents(payment)` (`requestRefund:336`) — nada
mais muda. `"refunded"`, `"pending"`, `"failed"` e `"expired"` continuam recusados.

**Testes de aceite (`tests/unit/refund-*.test.mjs`, fakeDb):**
1. Pedido com 2 itens: `cancel_item` do item A → concluído; `cancel_item` do item B →
   aceito e concluído; total confirmado = A + B; `Payment.status = "partially_refunded"`.
2. Segunda solicitação acima do saldo restante → recusada por teto, sem reserva.
3. `Payment.status = "refunded"` → recusado com 400, sem reserva, sem trava.
4. `Payment.status = "pending"` → recusado com 400.

---

## F2-02 · P0 · Solicitação pendente de pagamento já estornado nunca é retomada

**Evidência:** `base44/functions/expireStaleReservations/entry.ts:529`

```ts
if (pay.status !== "succeeded" || !pay.intent_id) continue;
```

**Defeito:** o mesmo defeito da F2-01, no reconciliador. Cenário concreto e provável:

1. `cancel_item` do item A confirmado → `Payment.status = "partially_refunded"`.
2. `cancel_item` do item B: reserva de valor + ingressos travados em `refund_pending`
   + trilha gravada + `createRefund` no Stripe.
3. A resposta HTTP do Stripe se perde (falha de rede).
4. A solicitação fica `pending` para o reconciliador. O reconciliador **pula para
   sempre** porque o pagamento não é mais `"succeeded"`.

**Impacto:** estado terminal travado. O ingresso de B fica em `refund_pending` (check-in
bloqueado por `checkinTicket`, mensagem "estorno em andamento"), a reserva de valor
continua presa, e nada na aplicação resolve — nem o timeout, nem uma nova tentativa do
usuário. Dinheiro possivelmente devolvido, ingresso inválido, estoque não devolvido: é
a pior combinação possível.

**Correção exata:** mesma lista fechada da F2-01 (ideal: extrair para
`base44/shared/refundGuards.ts` como `isRefundablePaymentStatus(status)` e usar nos
dois pontos, para os caminhos nunca mais divergirem):

```ts
if (!isRefundablePaymentStatus(pay.status) || !pay.intent_id) continue;
```

**Testes de aceite:**
1. `Payment.status = "partially_refunded"`, solicitação `pending` sem
   `stripe_refund_id`: o reconciliador consulta o Stripe, encontra o estorno por
   identidade e vincula (sem criar segundo estorno).
2. Mesmo cenário, estorno ausente no Stripe: cria com a **mesma** `idempotency_key`.
3. Mesmo cenário, estorno `failed`: marca `failed`, libera **só** a reserva da
   solicitação e destrava **só** os ingressos com aquele `refund_request_id`.
4. `Payment.status = "refunded"` e `"pending"` → não processa (continua pendente intacto).

---

## F2-03 · P1 · Estorno parcial faz a venda inteira sumir da receita

**Evidência:**
- `base44/functions/getEventSalesSummary/entry.ts:36` → `status: 'succeeded'`
- `base44/functions/getSalesMetrics/entry.ts:40` → `status: 'succeeded'`

**Defeito:** os dois relatórios somam `Payment.amount` apenas de pagamentos
`"succeeded"`. Depois de um estorno parcial o pagamento passa a `"partially_refunded"`
e **desaparece da soma** — em vez de valer `pago − estornado`.

**Impacto:** número errado para o organizador, e para baixo: um pedido de R$ 1.000 com
estorno parcial de R$ 100 derruba a receita do evento em R$ 1.000 em vez de R$ 100.
Decisão comercial (preço de lote, viabilidade de evento) tomada sobre dado falso.

**Correção exata:** incluir `partially_refunded` e descontar o valor confirmado do
ledger (nunca `refund_reserved_cents`, que não é dinheiro devolvido):

```ts
status: { $in: ['succeeded', 'partially_refunded'] }
// por pagamento:
const net = (Number(p.amount) || 0) - (Number(p.refunded_cents ?? Math.round((Number(p.refunded_amount) || 0) * 100)) / 100);
```

Manter `ordersPaid` contando os dois estados e expor separadamente, no retorno,
`refundedTotal` (soma de `refunded_cents`/100).

**Testes de aceite:**
1. 1 pedido de R$ 1.000 `succeeded` → receita 1.000.
2. Estorno parcial de R$ 100 → receita 900, `ordersPaid = 1`, `refundedTotal = 100`.
3. Estorno integral → receita 0, `refundedTotal = 1.000`.
4. Pagamento `pending`/`failed` continua fora da receita.

---

## F2-04 · P1 · Varredura de estornos sem paginação nem ordem determinística

**Evidência:** `base44/functions/expireStaleReservations/entry.ts:408`

```ts
const pendingReqs = await svc.entities.RefundRequest.filter({ status: 'pending', is_deleted: false });
```

**Defeito:** carrega **todas** as solicitações pendentes de todos os eventos, sem
`limit` e sem `sort`. A rodada para em `MAX_REFUND_RECONCILE_PER_RUN = 25`
(`:61`, checado em `:410`). Duas consequências:
- memória/latência crescendo com o histórico de pendências (e o mesmo padrão que a
  P1-B combate no resto do app);
- **starvation**: sem ordem, a mesma janela pode ser retomada a cada rodada e as
  solicitações fora dela nunca são tentadas.

**Correção exata:** página determinística, mais antiga primeiro, com laço de páginas
até o teto da rodada:

```ts
const page = await svc.entities.RefundRequest.filter(
  { status: 'pending', is_deleted: false },
  { sort: 'created_date', limit: MAX_REFUND_RECONCILE_PER_RUN },
);
const pendingReqs = page.items ?? page;
```

(Ou reutilizar `scanAll` de `base44/shared/completeScan.ts` com teto explícito, como já
é feito no reconciliador de fulfillment.) Não mudar `MAX_REFUND_RECONCILE_PER_RUN`.

**Testes de aceite:**
1. 40 pendentes, teto 25 → processa exatamente 25, das mais antigas.
2. Rodada seguinte processa as 15 restantes (não repete as 25 já resolvidas).
3. `page` vazio → rodada encerra sem erro.

---

## F2-05 · P1 · Estorno travado não tem visibilidade nem saída operacional

**Evidência:** `expireStaleReservations:449` e `:634` (`refundsBlocked++`) — o bloqueio
só existe no resumo da rodada; não há consulta, tela nem ação escopada por dono para
uma solicitação parada.

**Defeito:** solicitações bloqueadas (origem não autorizada, relações inconsistentes,
associação inconclusiva) mantêm ingressos em `refund_pending` **indefinidamente**. O
único caminho administrativo existente é `releaseLegacyRefundLocks`, que trata apenas
travas **sem dono** (legado) — não serve para uma trava com `refund_request_id`.

**Impacto:** titular na porta com ingresso bloqueado e ninguém sabe por quê; a
operação descobre por reclamação, não por painel.

**Correção exata (mínima, sem tela nova de módulo):**
1. Consulta administrativa (função backend, autorizada por `EVENT_FINANCE_ROLES` do
   próprio evento) que lista solicitações `pending` com idade, motivo do bloqueio,
   valor reservado e ingressos travados.
2. Ação administrativa explícita **escopada por dono**: liberar a trava de UMA
   solicitação (usa `unlockTicketsForRefund(..., req.id)` e
   `releaseRefundReservation(..., req.id, ...)`, com trilha obrigatória
   `estorno_trava_liberada_manual`). Nada de liberação em massa, nada sem dono.
3. No resumo da manutenção, incluir `refundsBlocked`, a idade da pendência mais antiga
   e a contagem de ingressos em `refund_pending`.

**Testes de aceite:**
1. Solicitação inconclusiva → aparece na listagem com motivo e ingressos travados.
2. Liberação manual → ingressos voltam a `issued`, reserva liberada **só** a dela,
   trilha gravada uma única vez (repetir é no-op).
3. Liberação manual de uma solicitação não libera ingresso de outra (CAS por dono).

---

## F2-06 · P1 · Estorno sem associação devolve dinheiro e mantém o ingresso válido

**Evidência:** `base44/shared/commerceFulfillment.ts` — `applyUnassociatedRefundAmount`
atualiza **apenas** `Payment` (`refunded_cents`, status). Ingressos, participantes e
estoque não são tocados (decisão correta: associação por aproximação poderia cancelar
o ingresso errado).

**Defeito:** o estorno feito direto no painel do Stripe (sem passar por
`requestRefund`) devolve o dinheiro, mas o ingresso continua `issued` e o
`quantity_sold` do lote não volta. Nada lista esses pagamentos para tratativa.

**Impacto:** ingresso válido com dinheiro devolvido (entrada gratuita) e estoque
inflado — invisível, porque não há consulta.

**Correção exata:** consulta administrativa `pagamentos com estorno sem solicitação`
(`refunded_cents > 0` e nenhum `RefundRequest` `processed`/`failed` para o pagamento) +
ação explícita de atribuição: escolher os `order_item_ids` afetados, criar a
solicitação com `provenance` do fluxo administrativo e executar
`processRefundSuccess` com `refundRequestId` — mantendo a regra de que **nada** é
atribuído automaticamente por valor/data.

**Testes de aceite:**
1. Pagamento com `refunded_cents > 0` e sem solicitação → aparece na consulta com
   valor e pedido.
2. Atribuição a um item → ingresso `refunded` com `refunded_by_request_id` da
   solicitação administrativa, participante cancelado, estoque devolvido **uma vez**.
3. Pagamento sem estorno não aparece; pagamento com solicitação `processed` não aparece.

---

## F2-07 · P2 · `amount_refunded` da solicitação registra o pedido, não o estornado

**Evidência:** `base44/shared/commerceFulfillment.ts:502`

```ts
amount_refunded: matched?.amount_requested || refundAmountBRL,
```

**Defeito:** o campo que deveria ser o valor efetivamente devolvido recebe
`amount_requested`. Em estorno parcial por valor com arredondamento, em estorno manual
no Stripe e em estorno cumulativo, o número no relatório deixa de ser o do provedor.

**Correção exata:** gravar o valor confirmado atribuível a esta solicitação (delta do
cumulativo do Stripe, limitado a `amount_requested`), mantendo `amount_requested`
intacto como referência. O portão do teto continua sendo `refunded_cents`
(cumulativo) — este campo é de relatório.

**Testes de aceite:**
1. Estorno de valor igual ao solicitado → `amount_refunded === amount_requested`.
2. Estorno confirmado menor que o solicitado → `amount_refunded` = valor do Stripe,
   `amount_requested` inalterado.
3. Dois estornos cumulativos no mesmo pagamento → cada solicitação com o seu delta
   (soma dos deltas = confirmado total).

---

## F2-08 · P2 · Reconciliação de fulfillment ignora pagamento já estornado

**Evidência:** `base44/functions/expireStaleReservations/entry.ts:338` →
`status: 'succeeded'`.

**Defeito:** pagamento que virou `partially_refunded` com `fulfillment_status =
pending_retry` (emissão interrompida + estorno manual no Stripe) sai do reconciliador
de emissão. Cenário de borda, mas deixa ingresso pago não emitido para sempre.

**Correção exata:** usar `status: { $in: ['succeeded', 'partially_refunded'] }` na
varredura de emissão, mantendo o claim de `fulfillment_status` e todas as guardas
(`is_deleted`, pedido cancelado, `fulfilling` stalo) como estão.

**Testes de aceite:**
1. `partially_refunded` + `pending_retry` → emissão retomada e concluída.
2. Reexecução → nenhum ingresso/participante duplicado.
3. `refunded` (integral) continua fora da varredura.

---

## Ordem sugerida dentro do mesmo patch

1. **F2-01 + F2-02 juntos** (mesma função de guarda; corrigir um sem o outro deixa um
   caminho cego).
2. **F2-04** (paginação da varredura) — reduz o universo que F2-02 vai retomar.
3. **F2-03 + F2-08** (relatórios e reconciliação de emissão).
4. **F2-05 + F2-06** (superfícies administrativas; maior esforço, não bloqueiam os
   anteriores).
5. **F2-07** (ajuste de relatório).

---

## Critério de aceite da Fase 2

- Nenhum caminho pode recusar um estorno elegível por causa do estado do pagamento
  já parcialmente estornado; o teto é sempre o ledger.
- Nenhuma solicitação `pending` pode ficar sem retomada por causa do status do
  pagamento.
- A receita de um evento após estorno parcial é `pago − confirmado`, nunca zero.
- Toda trava sem solução automática tem listagem, motivo e liberação manual escopada
  por dono, com trilha.
- Suíte `npm run test:unit:refund` verde, `npm run build` verde, ESLint 0 erros, e
  cada item provado por mutação (defeito reintroduzido → teste falha).

---

## O que esta lista NÃO cobre

- **P1-B** (paginação e minimização no restante do app), **P1-C** (concorrência de
  pontos e conexões) e **P2** (exclusão de conta e retenção) do
  `docs/PLANO-CORRECAO-RISCOS-2026-11-04.md` — são fases próprias, com dependências
  declaradas lá.
- **Hipóteses não provadas por leitura de código.** Tudo acima tem arquivo e linha;
  nada aqui é suspeita sem evidência.
- **Concorrência real de banco e ambiente Stripe.** Os testes provam a lógica contra o
  `fakeDb` (CAS por documento). Atomicidade no MongoDB real e o comportamento do
  Stripe continuam fora do alcance da suíte unitária.
