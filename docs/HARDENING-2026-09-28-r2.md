# Endurecimento r2 — 2026-09-28 (SEC-002 / FIN-001 / PERF-001)

## Contingência operacional — SEC-002 (expirador de reservas)

O endpoint `expireStaleReservations` passou a exigir **admin autenticado**
(anônimo 401, não-admin 403, conta excluída 403 via requireActiveUser). O
mecanismo de credencial do scheduler foi **removido** — o valor da credencial
antiga (`SCHEDULER_INTERNAL_TOKEN`) ficou exposto em arquivo versionado do
workflow e é considerada **comprometida**.

O workflow agendado "Expirar Reservas Abandonadas" (cron a cada 5 min) está
**desativado de verdade** (status `inactive` — não dispara) e não deve ser
reativado com credencial em arquivo versionado, argumento estático de
workflow ou qualquer mecanismo não suportado nativamente pela plataforma.

### Impacto operacional assumido (decisão consciente)

- Reservas de checkouts abandonados (15 min) **não expiram sozinhas** enquanto
  não houver scheduler seguro.
- Até lá, um **admin deve executar o expirador manualmente** (chamada
  autenticada à função `expireStaleReservations`) periodicamente — a execução
  é idempotente e reconcilia: expiração de reservas, emissão pela metade
  (`pending_retry`) e estornos pendentes sem webhook.
- O money-path não é afetado: pedidos pagos nunca são cancelados pelo job, e
  pagamentos com fulfillment pendente permanecem de pé até recuperação.

### Rotação de credencial (pendência humana)

O valor antigo da credencial não é lido por nenhum código desde r2, mas segue
no **histórico do git** e como secret da plataforma até rotação/exclusão
manual em Configurações → Secrets. Recomenda-se excluir o secret
`SCHEDULER_INTERNAL_TOKEN` (nenhum código o utiliza).

## FIN-001 r2 — locks de checkout por comprador+evento

Locks simultâneos e independentes por (comprador, evento): gate atômico no
array `Person.checkout_lock_events` (CAS `$ne`+`$push` — exatamente um
vencedor por evento em corrida) + registros `CheckoutLock` com pedido e TTL.
Liberação idempotente e escopada por evento em falha, cancelamento/expiração e
pagamento confirmado. Os campos escalares legados na Person ficam por
histórico (não são lidos/escritos desde r2).

## INF-003 (opção 2) — telefone de participante escondido como o CPF

Decisão de produto (2026-09-28): o telefone DEIXA de ser feature de
networking. `getEventParticipants` agora remove `phone` de qualquer lista
para não-gestão (ops `event`, `my_events`, `partner_speakers`) — mesmo
tratamento do CPF: visível apenas à gestão do evento (admin/manager/team) e
ao próprio dono (op `my`). A UI de networking nunca exibiu telefone, então
nenhum componente precisou mudar.

## PERF-001 — fim da truncagem silenciosa em métricas

- `getSalesMetrics`: Orders removidos do carregamento (nunca usados);
  Payment/Ticket/Event em varredura completa paginada (`scanAll`); resposta
  informa consultas e completude.
- `getEventSalesSummary`: varredura completa com filtros na query.
- `getEventOrders`: paginação backend obrigatória (total exato, limite,
  cursores, `has_more`); itens/ingressos carregados só da página; o wrapper
  do frontend percorre as páginas até esgotar (consumidores inalterados).