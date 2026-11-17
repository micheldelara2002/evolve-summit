# Evolve Summit — F4-03: proteção da conversão de estoque

**Data:** 2026-11-17 (America/Sao_Paulo)
**Escopo:** dois ajustes pontuais apontados na revisão independente da F4-02.
**Ambiente:** nenhum deploy, nenhuma publicação, nenhuma migração, nenhuma escrita em produção,
nenhum pagamento real, nenhuma alteração de entidade, RLS, workflow ou de outro módulo.

---

## 1. Estoque reservado negativo (corrigido)

`convertReservedToSoldOnce()` incrementava `quantity_sold` e decrementava `quantity_reserved`
condicionando a escrita apenas ao marcador do item. Um lote com `quantity_reserved` zerado (ou sem o
campo) ia a negativo e registrava uma venda sem reserva correspondente.

**Correção.** O filtro do `updateMany` passou a exigir, na MESMA escrita condicional,
`quantity_reserved >= 1` além de `stock_converted_order_item_ids` não conter o item. O incremento de
`quantity_sold` e o decremento de `quantity_reserved` continuam na mesma operação — nunca há venda
sem reserva nem reserva negativa.

Se a escrita não ocorre, a confirmação vem da LEITURA do lote (a resposta do update não é
autoridade) e o resultado é explícito:

| Situação lida no lote | Resultado |
|---|---|
| item já no marcador | `ja_convertido` (retry idempotente, sem efeito) |
| lote não encontrado | `lote_inexistente` |
| `quantity_reserved` < 1 ou ausente | `reservado_insuficiente` |
| nada acima, escrita não aplicada | `conversao_nao_aplicada` |
| falha de leitura | `leitura_indisponivel` |
| exceção na escrita | `conversao_indisponivel` |

## 2. Lote inexistente não é sucesso (corrigido)

`fulfillOrder` aceitava `lote_inexistente` como resultado bem-sucedido da conversão. Um pedido pago
podia ser declarado `fulfilled` com o estoque não convertido.

**Correção.** A decisão foi isolada em `blocksFulfillment(conversion, tracked)`:

- **Pedido com reserva identificada** (`StockReservation` existente): qualquer falha de conversão,
  lote inexistente inclusa, **bloqueia**. O pedido fica em `pending_retry`, o pagamento permanece
  `succeeded` e a reserva continua **viva** (o token não sai do lote) para a reconciliação. Nenhum
  estoque de pagamento confirmado é devolvido.
- **Pedido legado** (sem `StockReservation`): comportamento anterior preservado — lote ausente ou
  reserva insuficiente não impede o fulfillment. A conversão simplesmente não acontece: não há venda
  fantasma, não há reserva negativa, e o caso é registrado em log.
- Item já convertido é sempre sucesso (retry idempotente).

A leitura das reservas do pedido (`orderTracksStockReservations`) **lança** quando indisponível: erro
de leitura nunca é confundido com "pedido legado", então o fulfillment não conclui sem confirmação.

---

## 3. Testes

Nova suíte `tests/unit/f4-03-conversion-guard.test.mjs` (12 testes), incluída em
`npm run test:unit:f4`:

| # | Cenário | ✅ |
|---|---|---|
| 1 | `quantity_reserved = 0` → `reservado_insuficiente`, sold 0, reservado não vai a negativo | ✅ |
| 2 | `quantity_reserved` ausente → falha explícita, campo não é criado | ✅ |
| 3 | `quantity_reserved = 1` → converte exatamente uma unidade | ✅ |
| 4 | item já convertido em retry → `ja_convertido`, sold permanece 1 | ✅ |
| 5 | duas conversões concorrentes do mesmo item → um vencedor, sold 1 | ✅ |
| 6 | retries repetidos → nenhuma venda extra, reservas de outros itens intactas | ✅ |
| 7 | lote inexistente → falha explícita, nenhuma escrita | ✅ |
| 8 | falha de LEITURA na confirmação + retry → sold 1, retry conclui por `ja_convertido` | ✅ |
| 9 | lote inexistente com reserva identificada → bloqueia o fulfillment | ✅ |
| 10 | lote inexistente / reserva insuficiente em pedido legado → não bloqueia, sem venda fantasma | ✅ |
| 11 | reserva identificada: insuficiente, escrita e leitura indisponíveis bloqueiam; `ja_convertido` e convertido não | ✅ |
| 12 | leitura das reservas do pedido indisponível → lança (não vira legado) | ✅ |

### Resultados

| Verificação | Resultado |
|---|---|
| `npm run test:unit:f4` (3 arquivos) | **53/53** |
| `npm run test:unit:refund` | 115/115 |
| `npm run test:unit:fase3` | 35/35 |
| `npm run test:unit:migration` | 25/25 |
| `npm run test:unit:security` | 9/9 |
| `npm run build` | exit 0 |
| `npx eslint` (arquivos alterados) | 0 problemas |
| `npm run typecheck` | 1.814 erros **preexistentes** (nenhum nos arquivos alterados) |

---

## 4. Limitações e riscos residuais

1. **Concorrência em banco real não exercitada.** O banco falso reproduz a atomicidade POR DOCUMENTO
   e a avaliação do filtro no instante da escrita; não reproduz latência, réplica de leitura,
   timeout nem concorrência entre processos. O teste de duas conversões concorrentes prova a FÓRMULA
   da escrita condicional (um único vencedor por item), não o comportamento do banco real.
   Homologação com carga concorrente permanece pendente.
2. **Sem transação entre documentos** na plataforma: a garantia é CAS de um documento + confirmação
   por leitura. Crash entre a emissão do ingresso e a conversão deixa o pagamento em `pending_retry`
   e a reserva viva — a reconciliação retoma; nunca há venda duplicada nem devolução de compra paga.
3. **Reserva com lote ausente fica retida** (estado recuperável) até correção do lote ou intervenção
   da gestão; o reconciliador reporta o caso como `pending`, sem liberar o estoque do pagamento.
4. **Pedidos legados sem reserva identificada** não convertem estoque quando o lote está ausente ou
   sem unidade reservada: o fulfillment segue, mas `quantity_sold` não é incrementado — preferimos
   não registrar venda fantasma a manter números inflados por dado inconsistente.
5. **E2E autenticado por perfil e carga** seguem não executados (bloqueio de infraestrutura).

---

## 5. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `base44/shared/stockReservation.ts` | filtro exige `quantity_reserved >= 1`; resultados explícitos (`reservado_insuficiente`); `orderTracksStockReservations` fail-closed |
| `base44/shared/commerceFulfillment.ts` | `blocksFulfillment` (lote inexistente deixa de ser sucesso em pedido com reserva identificada); legado preservado |
| `tests/unit/f4-03-conversion-guard.test.mjs` | **novo** — 12 cenários |
| `package.json` | `test:unit:f4` inclui a nova suíte |
