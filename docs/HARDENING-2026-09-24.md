# Hardening Transacional — Correções do Audit (2026-09-24)

Lote completo das 13 falhas da auditoria transacional (2 críticas, 3 altas, 8 médias).

## Críticas

1. **Job de expiração cancelava pedidos pagos** (`expireStaleReservations`)
   - Antes: o job só via pagamentos `pending` do pedido — um pagamento `succeeded`
     com emissão em `pending_retry` era invisível e o pedido (pago!) era cancelado,
     com devolução das reservas e soft-delete dos itens.
   - Agora: checa TODOS os pagamentos; pagamento vivo (`succeeded` ou fulfillment
     `pending_retry`/`fulfilled`) mantém o pedido de pé, promove a `paid`, grava
     auditoria (`stale_reservation_kept_paid`) e a emissão pendente segue visível
     na aba de transações com o botão de retry.
   - O webhook `payment_intent.canceled` e o polling (`getPaymentStatus`) usam a
     mesma regra de "pagamento vivo" (irmãos pending/succeeded/pending_retry/fulfilled).

2. **Re-checkout travado por chave de idempotência + dupla cobrança**
   (`createPaymentIntent`)
   - Chave do Stripe agora é `pi_create_<orderId>_<ts>_<tentativa>` — única por
     tentativa (o Stripe casheia a chave por 24h; reusar a chave do pedido
     devolvia o intent antigo, possivelmente cancelado).
   - O intent retornado é revalidado (vivo + valor correto) antes de devolver o
     `client_secret`; intent inválido é cancelado e recriado.
   - Reuso do pedido pendente ganhou claim atômico (CAS sobre `reserved_until`):
     duas abas concorrentes não empilham itens no mesmo pedido (a segunda recebe 409).
   - Falha ao cancelar o intent antigo ABORTA o re-checkout (502) — nunca dois
     intents pagáveis sobre o mesmo pedido.

## Altas

3. **Janela de órfão no fulfillment** (`fulfillOrder`): participante criado mas
   não vinculado (crash) não gera duplicata — o retry adota o órfão da mesma
   pessoa (person_id + event_id, criado após o pedido) sem ingresso apontando
   para ele, antes de criar um novo.

4. **Claim de fulfillment com estado intermediário**: `Payment.fulfillment_status`
   ganhou `fulfilling` — o claim marca `fulfilling` (não `fulfilled`) enquanto o
   laço de emissão roda; crash no meio deixa recuperável. `retryFulfillment`
   aceita `pending_retry` e `fulfilling` (stalo > 10 min); o job de expiração
   roda um reconciler que varre pagamentos `succeeded` × ingressos/participantes
   e marca emissões pela metade como `pending_retry`.

5. **Fees/cobranças**: ver Crítica 2 (abort + claim atômico + chave por tentativa).

## Médias

6. **Estorno direto no painel do Stripe sobre ingresso usado**: o webhook
   `charge.refunded` não cancela ingressos `used` silenciosamente — o ingresso
   segue válido, o evento gera auditoria (`refund_used_ticket_blocked`) e a
   `RefundRequest` casada é marcada `failed` com motivo (reverter check-in é
   pré-requisito). O valor financeiro segue autoritativo do Stripe.
7. **Teto de estorno TOCTOU**: `requestRefund` reserva atomicamente o valor
   (CAS `$lte` + `$inc` em `Payment.refunded_amount`); dois estornos concorrentes
   não passam ambos (409). Reserva é devolvida se o Stripe recusar; o webhook
   continua sendo o gravador autoritativo cumulativo (assign converge).
8. **Cancelamento gratuito repetido**: chamada no-op em pedido já `refunded` é
   rejeitada; chave de dedupe de e-mail derivada do pedido + itens afetados
   (não do ID da nova RefundRequest).
9. **`Order.error_reason`** adicionado ao schema (antes era gravado e descartado).
10. **PDF de ingresso em replay**: `deliverTickets` pula a geração (QR + jsPDF)
    quando o marcador `EmailDeliveryLog` (`ticket_delivery:<ticket_id>`) já existe.
11. **Taxa Stripe no polling/retry**: `captureStripeFee` compartilhado — usada no
    webhook, no `getPaymentStatus` e no `retryFulfillment`.
12. **Hot paths sem índice**: ver seção abaixo.
13. **Emissão à prova de crash**: ver Altas 3 e 4.

## Hot paths sem índice (Média 12 — registro de monitoramento)

A plataforma não expõe criação de índices compostos por entidade (confirmado na
documentação). Mitigação aplicada: lookups de igualdade quentes usam
`filter(query, sort, limit)` com limite 1 — o backend lê um documento em vez de
varrer a coleção inteira mesmo sem índice.

| Campo | Caminho quente | Mitigação |
|---|---|---|
| `Payment.intent_id` | webhook (succeeded/failed/canceled/refunded), polling | limit 1 |
| `Ticket.order_item_id` | fulfillment por item | comparado por ticket existente |
| `Ticket.participant_id` | reconciliação de órfãos | varredura por ordem |
| `Person.contact_email` | `ensurePerson` no fulfillment | limit 1 |
| `RefundRequest.payment_id` | associação de estorno no webhook | pequena por pagamento |

**Monitoramento**: no dashboard → Logs, observar latência/falhas dos handlers
`stripeWebhook`, `getPaymentStatus` e `expireStaleReservations`. Se o volume de
pagamentos crescer a ponto de esses lookups dominarem o tempo de execução,
revisitar com o suporte da plataforma (índices ou campos de agrupamento
adicionais, ex. `event_id` já presente nos filtros de varredura).

## Validação

- Build de produção e testes das funções alteradas.
- Testes E2E de checkout multitentativa: rodar com o runner do time
  (credenciais em `tests/seed/env.mjs`) — `npx playwright test tests/e2e`.