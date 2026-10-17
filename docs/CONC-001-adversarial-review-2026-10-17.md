# CONC-001 — Revisão adversarial independente (2026-10-17)

Modo: inspeção + testes não destrutivos. Nenhum código, dado, config ou
workflow alterado. Nenhuma operação financeira real executada.

## 1. Consultas analisadas (arquivos e condições exatas)

- `base44/shared/commerceFulfillment.ts` 583-604 — `lockTicketsForRefund`:
  claim CAS `{ id: $in, status: "issued" }` + `$set { status, refund_request_id }`;
  rollback parcial `{ id: $in, status: refund_pending, refund_request_id = req.id }`
  (sem id: `$exists: false`).
- `base44/shared/commerceFulfillment.ts` 614-629 — `unlockTicketsForRefund`:
  `{ order_id, status: "refund_pending", [order_item_id: $in], $or:
  [refund_request_id = req.id, refund_request_id $exists: false,
  refund_request_id null] }` → `$set { status: "issued" }`.
- `base44/shared/commerceFulfillment.ts` 481-511 — `processRefundSuccess`:
  cancela `refund_pending`/`issued` (não `used`/`refunded`/`cancelled`),
  zera o dono, cancela participante, dec lot/métricas.
- `base44/functions/requestRefund/entry.ts` 119-154 — gate de identidade
  (payment + refund_type + itens); 181-203 (free) e 333-365 (pago) —
  RefundRequest criada ANTES da trava; compensações escopadas por req.id.
- `base44/functions/expireStaleReservations/entry.ts` 366-400 e 460-486 —
  reconciler de estornos: retry DAT-002 (`!stripe_refund_id && idempotency_key`
  → createRefund de novo) e destrava escopada por req.id.

## 2. Cenários executados (harness com interleavings forçados)

Semântica Mongo replicada exatamente (null casa campo ausente, $exists, $in,
$or raiz). 6 cenários, 22 asserções — 22 PASS, 0 FAIL.

1. **S1 — duas solicitações simultâneas, mesma identidade**: B barrado como
   `idempotent_replay` antes de tocar travas; 1 RefundRequest. OK.
2. **S2 — B falha enquanto A ativa (identidades distintas, full × cancel_item)**:
   B perde o CAS, rollback de B não toca A; unlock de B não destrava A;
   check-in bloqueado durante e após o estorno de A. OK.
3. **S3 — reconciler durante estorno em andamento**: falha processada pelo
   reconciler não solta trava alheia. OK. **Mas**: retry DAT-002 re-dispara o
   refund SEM re-travar ingressos (achado F2).
4. **S4 — ingresso legado sem dono + carimbados**: solicitação NOVA (pós-deploy)
   em falha destrava o ingresso legado sem carimbo (não travado por ela) e o
   check-in REABRE durante estorno alheio em andamento (achado F1). Ingressos
   carimbados permanecem protegidos (contraprova: escopo estrito = 0 toques).
5. **S5 — reexecução de rollback/reconciler**: no-op idempotente; CAS parcial
   com ingresso `used` devolve só o próprio; refundSuccess re-executado
   converge. OK.
6. **S6 — falha entre create da RefundRequest e a trava**: ingresso fica
   `issued`, retry do usuário é barrado ("aguarde") e o reconciler COMPLETARIA
   o estorno sobre um ingresso nunca travado (achado F2).

## 3. Integridade e recuperação

- Nenhuma compensação libera trava carimbada de outra solicitação (S2/S3/S4). OK.
- Falhas parciais não deixam ingressos permanentemente travados; rollback e
  unlock são idempotentes e re-executáveis (S5). OK.
- Transições válidas: issued→refund_pending (CAS+carimbo), refund_pending→issued
  (unlock escopado), refund_pending/issued→refunded (confirmado; `used` nunca
  é cancelado silenciosamente). `used`→refunded é recusado (usedSkipped).
- Estado real em Produção (leitura read-only): **0** ingressos `refund_pending`
  e **0** RefundRequests pendentes → não há travas legadas vivas hoje.

## 4. Status dos testes

- Aprovados: 22 asserções de lógica (harness).
- Bloqueados (não executados): execução real dos updateMany com `$or`+`null`
  contra banco de dados — o SDK do exec_tool não expõe o banco de Teste para
  CAS, e escritas simuladas em Produção violariam o modo não destrutivo.
  Mitigação da lacuna: a mesma família de primitivas (`{field: null}` casando
  campo ausente, CAS `$ne`/`$in`) já foi validada em produção no checkout_lock
  (DAT-001/FIN-001, 2026-09-28) e no gate de capacidade de sessões (2026-10-09).

## 5. Riscos residuais e correção mínima recomendada

- **F1 (P0, janela de deploy)**: o fallback legado (`$exists: false`/`null`)
  vale para TODAS as solicitações, inclusive pós-deploy — uma compensação nova
  pode destravar trava legada alheia no mesmo pedido (S4). Correção mínima:
  limitar o fallback às solicitações criadas ANTES do corte de deploy
  (`created_date < 2026-10-17T00:00:00Z` do chamador) e, após uma migração
  one-shot que carimbe travas órfãs com o dono (match pedido/itens), remover o
  fallback. Como não há travas legadas vivas hoje, o fallback pode ser removido
  já com baixo risco.
- **F2 (P0)**: janela entre create e trava (crash) + reconciler DAT-002
  re-dispara o refund com ingresso `issued` (nunca travado) — estorno pode
  confirmar com check-in possível (S6). Correção mínima: antes do
  `createRefund` no reconciler, re-afirmar a trava
  (`lockTicketsForRefund(svc, ingressos dos itens, req.id)`); se falhar,
  marcar a solicitação `failed` e devolver o teto.
- **F3 (P2)**: crash no caminho gratuito deixa RefundRequest `pending` que
  bloqueia retries ("aguarde") sem recuperação automática — exige intervenção
  manual. Nenhum dado hoje afetado (0 pendentes).

CONC-001 NÃO está plenamente validado: proteção por dono correta e comprovada
na lógica; F1 e F2 são lacunas reais pendentes de correção (aguardando
autorização explícita).