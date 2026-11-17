# Evolve Summit — F4-04: bloqueio de fulfillment com conversão de estoque pendente

**Data:** 2026-11-17 (America/Sao_Paulo)
**Escopo:** lacuna apontada na revisão independente da F4-03 (retry de `fulfillOrder()`).
**Ambiente:** nenhum deploy, nenhuma publicação, nenhuma migração, nenhuma escrita em produção,
nenhum pagamento/estorno real, nenhuma alteração de entidade, RLS, workflow ou de módulos fora do
escopo (apenas `stockReservation.ts`, `commerceFulfillment.ts`, biblioteca de teste e a nova suíte).

---

## 1. Defeito corrigido

`fulfillOrder()` chamava `convertReservedToSoldOnce()` **dentro de `if (!ticket)`**. Em um retry, o
ingresso já existia, então a conversão reservado→vendido era **pulada**. Além disso, o resultado da
retomada e do encerramento das reservas era apenas registrado em `console.warn` — o pedido era
marcado `fulfilled` mesmo com conversão pendente, com falha de leitura ou com estado não confirmado.

Consequências: pedido pago concluído sem `quantity_sold` correspondente (estoque preso em
`quantity_reserved`) e reserva encerrando sem venda — divergência silenciosa entre receita e estoque.

## 2. Correções aplicadas

### 2.1 Conversão verificada também para ingresso existente

A conversão saiu do bloco de criação do ingresso e passou a rodar para **todo item de pedido**,
inclusive quando o ingresso já existia. A idempotência continua garantida pela escrita condicional
(`stock_converted_order_item_ids` na mesma escrita do `$inc`): repetir não duplica ingresso,
participante nem `quantity_sold`. `blocksFulfillment()` segue decidindo o bloqueio (F4-03).

### 2.2 `resumeOrderStockConversion()` com estado explícito de indisponibilidade

Assinatura passou a devolver `{ converted, pending, unavailable, reasons, legacy }`:

- **Leitura das reservas** é feita com erro explícito (não usa o helper que devolve `[]` em falha —
  isso confundiria falha de leitura com "pedido legado") → `unavailable: true`,
  `reasons: ["reservas_indisponiveis"]`.
- **Leitura de OrderItem/Ticket** indisponível → `unavailable: true`,
  `reasons: ["itens_ou_ingressos_indisponiveis"]` (nunca `pending: 0` como "nada a fazer").
- **Permanecem pendentes**, com motivo em `reasons`: item sem ingresso (`sem_ingresso`),
  `lote_inexistente`, `reservado_insuficiente`, `conversao_indisponivel`, `leitura_indisponivel`,
  `conversao_nao_aplicada`, `item_sem_identidade`.
- **Só contam como concluídos** `convertido` e `ja_convertido`. `ja_convertido` é o resultado da
  **leitura do marcador no lote** feita por `convertReservedToSoldOnce` — nunca da resposta da
  escrita (que não prova nada quando retorna zero atualizações).

### 2.3 Portão obrigatório antes de `fulfilled`

Antes de marcar pedido/pagamento como `fulfilled`, para pedido **com reserva identificada**:

| Verificação | Efeito |
|---|---|
| retomada `unavailable` | **bloqueia** |
| `resumed.pending > 0` | **bloqueia** (lista os motivos no erro) |
| `consumeOrderReservations().pending > 0` (reserva com conversão incompleta) | **bloqueia** |

O erro não é engolido: o `catch` já existente deixa `Payment.status = 'succeeded'`,
`Payment.fulfillment_status = 'pending_retry'`, `Order.fulfillment_status = 'pending_retry'` e a
**reserva VIVA** (token preservado no lote), com `error_reason` descritivo — visível na aba de
transações e recuperável por `retryFulfillment`/reconciliação.

**Pedido legado** (sem `StockReservation`) não entra no portão: comportamento anterior preservado
(ausência de lote ou de reserva não impede o fulfillment) e nenhuma venda fictícia é registrada.

---

## 3. Cenários testados (integração do fluxo completo)

Suíte nova `tests/unit/f4-04-fulfillment-gate.test.mjs` — chama a função de produção
`fulfillOrder()` ponta a ponta (emissão de ingresso + participante, conversão, retomada, encerramento
de reserva) contra o banco falso, não apenas funções isoladas.

| # | Cenário | Resultado |
|---|---|---|
| 1 | Primeira tentativa cria ingresso e falha na conversão (`reservado_insuficiente`): pedido NÃO conclui, participante não é criado, reserva `active`, token intacto, pagamento `succeeded` + `pending_retry` | ✅ |
| 2 | Retry encontra o ingresso existente e **converte** o estoque: `fulfilled`, `quantity_sold` 1, reserva `consumed`, token removido, 1 ingresso e 1 participante | ✅ |
| 3 | Retry com lote inexistente: não conclui; nenhuma venda; estoque de terceiros intocado | ✅ |
| 4 | Retry com reserva insuficiente: não conclui; `quantity_reserved` não vai a negativo | ✅ |
| 5 | Falha na consulta de **Ticket**: não conclui, nada é emitido sem poder conferir o existente | ✅ |
| 5b | Falha na consulta de **OrderItem** na retomada: não conclui; reserva continua `active` com token | ✅ |
| 6 | Falha na **retomada** (reservas ilegíveis), com a conversão do item já efetivada: **bloqueia** em vez de apenas avisar | ✅ |
| 7 | Retry após conversão completa: `quantity_sold` não duplica, 1 ingresso, 1 participante | ✅ |
| 8 | Pedido legado: conclui; lote com reserva zerada e lote inexistente não geram venda fantasma | ✅ |
| 9 | Pedido com 2 itens no mesmo lote: bloqueia com 1 unidade convertida; conclui só quando as duas convertem, com 1 ingresso por item | ✅ |

Asserções cobrem estado final de `StockReservation` (state/token), `SalesLot`
(`quantity_sold`/`quantity_reserved`/`reservation_tokens`), `Ticket`, `Participant`, `Order`,
`Payment` e `error_reason` — inclusive **ausência** de duplicidade.

## 4. Resultados

| Verificação | Resultado |
|---|---|
| `npm run test:unit:f4` (4 arquivos) | **63/63** (10 novos) |
| `npm run test:unit:refund` | 115/115 |
| `npm run test:unit:certhttp` | 65/65 |
| `npm run test:unit:fase3` | 35/35 |
| `npm run test:unit:migration` | 25/25 |
| `npm run test:unit:authz` | 13/13 |
| `npm run test:unit:security` | 9/9 |
| `npm run test:unit:csv` | 12/12 |
| `npm run test:unit:access` | 7/7 |
| `npm run build` | exit 0 |
| `npx eslint` (arquivos alterados) | 0 problemas |
| `npm run typecheck` | 1.814 erros **preexistentes** (nenhum nos arquivos tocados) |

**Total de testes únicos: 344** (335 anteriores + 9 únicos novos; a suíte F4 passou de 53 para 63).

## 5. Limitações e riscos residuais

1. **Concorrência em banco real não exercitada.** O banco falso reproduz a atomicidade por
   documento e a avaliação do filtro no instante da escrita, não latência, réplica de leitura,
   timeout nem concorrência entre processos. Os testes provam o **fluxo e a decisão de bloqueio**,
   não o comportamento de um banco real. Homologação com carga concorrente permanece pendente.
2. **Desbloqueio operacional.** Um pedido bloqueado permanece `pending_retry` até que a causa seja
   corrigida (lote recomposto, leitura normalizada). Nada é devolvido automaticamente: o estoque de
   compra paga fica retido — deliberadamente, para nunca vender duas vezes.
3. **Reserva maior que os itens ativos do lote.** Se `StockReservation.quantity` for superior ao
   número de itens vivos daquele lote no pedido (dado inconsistente/legado), a reserva não pode ser
   encerrada e o fulfillment fica bloqueado até intervenção. Preferimos bloquear a concluir com
   estoque não convertido; o caso aparece como `pending` nas reconciliações.
4. **Estado intermediário visível.** Um fulfillment bloqueado pode deixar ingresso emitido sem
   participante até o retry (comportamento anterior preservado); o check-in já repara a sincronização
   e o pedido segue marcado para retry, nunca `fulfilled`.
5. **Falha de leitura bloqueia também o legado.** Se a consulta de `StockReservation` falhar, o
   pedido fica em `pending_retry` mesmo sendo legado: fail-closed escolhido para não concluir sem
   saber se existe reserva identificada.
6. **E2E autenticado por perfil, RLS real, concorrência e carga** continuam não executados (bloqueio
   de infraestrutura).

## 6. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `base44/shared/stockReservation.ts` | `resumeOrderStockConversion` devolve `unavailable`/`reasons`; leitura de reservas com erro explícito; resultados não confirmados ficam pendentes; `ja_convertido` confirmado por leitura |
| `base44/shared/commerceFulfillment.ts` | conversão verificada para ingresso já existente; portão obrigatório antes de `fulfilled` (retomada + encerramento não são mais ignorados) |
| `tests/unit/f4-04-fulfillment-gate.test.mjs` | **novo** — 10 cenários de integração do fluxo completo |
| `tests/unit/lib/fakeDb.mjs` | coleções `Person`/`Event`/`User`/`CheckoutLock`; lista de valores tratada como `$in`; `is_deleted: false` por padrão no create |
| `package.json` | `test:unit:f4` inclui a nova suíte |
