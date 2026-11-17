# Evolve Summit — F4-05: fail-closed na leitura e no encerramento das reservas

**Data:** 2026-11-17 (America/Sao_Paulo)
**Escopo:** lacuna apontada na revisão independente da F4-04 — `consumeOrderReservations()`.
**Ambiente:** nenhum deploy, nenhuma publicação, nenhuma migração, nenhuma escrita em produção,
nenhum pagamento/estorno real, nenhuma alteração de entidade, RLS, workflow ou de módulos fora do
escopo. Alterações limitadas a `stockReservation.ts`, `commerceFulfillment.ts`, uma suíte nova de
testes e o script `test:unit:f4`.

---

## 1. Defeitos corrigidos

### 1.1 Falha de leitura virava "não existem reservas"

`listOrderReservations()` capturava qualquer exceção e devolvia `[]`. Em
`consumeOrderReservations()` isso significava `{ consumed: 0, pending: 0 }` — indistinguível de
"todas as reservas foram encerradas" — e o portão de fulfillment aprovava o pedido **sem saber se
havia reserva por encerrar**. Uma falha momentânea de leitura encerrava o pedido com a reserva e o
token de estoque ainda vivos.

### 1.2 Leitura de conversão virava "zero unidades convertidas"

`convertedUnitsFor()` também devolvia `0` em exceção. Como `0` é um valor legítimo (nada convertido),
não havia como o chamador perceber a falha.

### 1.3 Reserva com quantidade inválida/zero era consumida sem conversão comprovada

`consumeReservationIfFullyConverted()` calculava `needed = Math.abs(Number(quantity) || 0)`. Com
`quantity` ausente, ilegível ou `0`, `needed` virava `0` e a comparação `converted < needed` era
**falsa** — a reserva era encerrada (`consumed`), com o token removido do lote, sem nenhuma unidade
convertida confirmada.

## 2. Correções aplicadas

### 2.1 Leitura com resultado explícito

`listOrderReservations()` passou a devolver `{ ok, records, reason }`:

| Situação | Retorno |
|---|---|
| consulta concluída, com registros | `{ ok: true, records }` |
| consulta concluída, **vazia** | `{ ok: true, records: [] }` — confirmação real |
| exceção na consulta | `{ ok: false, reason: "reservas_ilegiveis:<erro>" }` |
| retorno não-array (resposta inválida) | `{ ok: false, reason: "reservas_ilegiveis:retorno_invalido" }` |
| pedido sem identidade | `{ ok: false, reason: "pedido_sem_identidade" }` |

`convertedUnitsFor()` devolve `{ count, unavailable, reason }`: falha de leitura é `unavailable: true`
(com `convertidas_ilegiveis:<erro>`), nunca `0` silencioso. Reserva sem lote/pedido de origem também é
`unavailable` — sem identidade não há como confirmar conversão.

### 2.2 `consumeOrderReservations()` diferencia vazio de indisponível

Novo contrato: `{ consumed, pending, unavailable, reasons }`.

- **Leitura indisponível** → `{ consumed: 0, pending: 0, unavailable: true, reasons: [...] }`.
  `pending: 0` nunca significa conclusão quando `unavailable` é `true`.
- **Leitura vazia** → `{ consumed: 0, pending: 0, unavailable: false, reasons: [] }`.
- **Falha ao conferir as unidades convertidas de um registro** → `unavailable: true`, e aquele
  registro continua **pendente** (nunca é encerrado às cegas).
- Cada registro não encerrado entra em `reasons` como `<id>:<motivo>`
  (`quantidade_invalida`, `conversao_incompleta`, `convertidas_ilegiveis…`).

### 2.3 Quantidade inválida ou zero é fail-closed

`consumeReservationIfFullyConverted()` só encerra com quantidade **finita e positiva** legível.
Sem ela: `consumed: false`, `reason: "quantidade_invalida"`, registro **permanece vivo** com o token
no lote. A reconciliação (`reconcileStockReservations`) herda o comportamento: antes encerrava uma
reserva de quantidade `0` sem confirmação; agora mantém e reporta como pendente.

### 2.4 Portão de fulfillment reforçado

Em `fulfillOrder()`, antes de marcar `fulfilled`:

| Verificação | Efeito |
|---|---|
| retomada `unavailable` (F4-04) | **bloqueia** |
| retomada `pending > 0` (F4-04) | **bloqueia** |
| **encerramento `unavailable` (F4-05)** | **bloqueia** — "encerramento das reservas de estoque não confirmado (…)"; antes passava |
| encerramento `pending > 0` | **bloqueia**, agora com os motivos no erro |

O bloqueio usa o `catch` existente: `Payment.status = 'succeeded'` (dinheiro preservado),
`Payment.fulfillment_status = 'pending_retry'`, `Order.fulfillment_status = 'pending_retry'`,
`error_reason` descritivo, reserva `active` e **token intacto no lote** — recuperável por
`retryFulfillment`/reconciliação. Pedido legado (sem `StockReservation`) segue no comportamento
anterior quando a consulta responde vazia; se a consulta falhar, também bloqueia (fail-closed).

## 3. Testes de fluxo completo

Nova suíte `tests/unit/f4-05-reservation-close-failclosed.test.mjs` — chama a função de produção
`fulfillOrder()` ponta a ponta (ingresso + participante, conversão, retomada, encerramento) contra o
banco falso, além de chamadas diretas a `consumeOrderReservations()`.

A falha de leitura é injetada na N-ésima consulta de reservas, reproduzindo "a primeira consulta
funciona e a segunda falha":

| # | Cenário | Resultado |
|---|---|---|
| 1 | Consultas 1 (detecção) e 2 (retomada) funcionam, a 3ª (encerramento) falha: pedido **não** conclui, erro `encerramento das reservas de estoque não confirmado` + `reservas_ilegiveis`; pagamento `succeeded`, pedido/pagamento `pending_retry`, pedido não `paid`; reserva `active`; token `T` intacto; `quantity_sold` 1; 1 ingresso e 1 participante | ✅ |
| 2 | Chamada direta com consulta indisponível: `unavailable: true`, `consumed: 0`, `pending: 0` **sem** significar conclusão, motivo reportado | ✅ |
| 3 | Retry após normalizar a leitura: conclui; `quantity_sold` não duplica; 1 ingresso; 1 participante; reserva `consumed`; token removido só na conclusão; pedido `paid`/`fulfilled` | ✅ |
| 4 | Reserva com `quantity: 0`: bloqueia com `quantidade_invalida`; reserva `active`; token preservado; pedido em retry | ✅ |
| 5 | `quantity` zero, ilegível (`"abc"`) e ausente: nenhuma consumida, todas `pending` com `quantidade_invalida`, estado `active`, token `T` | ✅ |
| 5b | Falha ao conferir as unidades convertidas (`OrderItem` ilegível): `unavailable: true`, `pending: 1`, reserva `active`, token preservado | ✅ |
| 6 | Consulta **vazia** (`unavailable: false`, `reasons: []`) conclui o pedido legado sem venda fictícia; a mesma consulta **falhando** é distinguida (`unavailable: true`) e bloqueia o pedido | ✅ |

## 4. Resultados

| Verificação | Resultado |
|---|---|
| `npm run test:unit:f4` (5 arquivos) | **70/70** (7 novos) |
| `npm run test:unit:refund` | 115/115 |
| `npm run test:unit:security` | 9/9 |
| `npm run test:unit:csv` | 12/12 |
| `npm run build` | exit 0 |
| `npx eslint` (arquivos alterados) | 0 problemas |
| `npm run typecheck` | 1.814 erros **preexistentes** (nenhum nos arquivos tocados) |

## 5. Riscos residuais

1. **Concorrência em banco real não exercitada.** O banco falso reproduz a atomicidade por documento
   e a avaliação do filtro no instante da escrita; não reproduz latência, réplica de leitura nem
   timeout. Os testes provam o fluxo e a decisão de bloqueio. Homologação com carga concorrente
   continua pendente.
2. **Bloqueio por indisponibilidade persistente.** Uma falha de leitura duradoura mantém o pedido em
   `pending_retry` indefinidamente (nada é devolvido e nada é declarado cumprido). É intencional, mas
   depende de observabilidade: o motivo fica em `Payment.error_reason` e nos `reasons` reportados pela
   reconciliação, visível na aba de transações.
3. **Reserva de quantidade inválida permanece viva.** Zero/ilegível não é encerrada nem devolvida
   automaticamente: exige correção do dado (a reconciliação a reporta como pendente a cada execução).
   Para registros legados essa reserva pode reter `quantity_reserved` até intervenção.
4. **Desbloqueio operacional.** Um pedido bloqueado não é retomado sozinho pelo portão; a retomada
   acontece em `retryFulfillment`, na reconciliação agendada ou no reenvio do webhook.
5. **Estado intermediário visível.** Um fulfillment bloqueado pode deixar ingresso emitido sem
   participante até o retry (comportamento anterior preservado); o check-in já repara a sincronização
   e o pedido nunca é marcado `fulfilled` nesse estado.
6. **E2E autenticado por perfil, RLS real e carga** continuam não executados (bloqueio de
   infraestrutura de testes).

## 6. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `base44/shared/stockReservation.ts` | `listOrderReservations` devolve `{ ok, records, reason }`; `convertedUnitsFor` devolve `{ count, unavailable }`; `consumeReservationIfFullyConverted` recusa quantidade inválida/zero e leitura indisponível; `consumeOrderReservations` devolve `{ consumed, pending, unavailable, reasons }` |
| `base44/shared/commerceFulfillment.ts` | portão de fulfillment bloqueia `consumed.unavailable` e reporta os motivos de reserva pendente |
| `tests/unit/f4-05-reservation-close-failclosed.test.mjs` | **novo** — 7 cenários de fluxo completo |
| `package.json` | `test:unit:f4` inclui a nova suíte |

Não houve alteração de contrato público além dos retornos internos acima: `listOrderReservations` e
`convertedUnitsFor` são privados do módulo, e o único chamador de `consumeOrderReservations` é o
portão em `commerceFulfillment.ts` (mais os testes).
