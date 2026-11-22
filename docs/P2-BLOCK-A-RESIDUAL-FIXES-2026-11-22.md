# P2 — Bloco A (integridade transacional): resíduos fechados

**Data:** 2026-11-22 · **Escopo:** P2-01, P2-03, P2-06, P2-08 (resíduos)
**Estado:** implementado e verificado localmente · **não publicado**

---

## 1. O que este documento cobre

O bloco A de integridade transacional já estava implementado (ver
`docs/P2-BLOCO-A-INTEGRIDADE-TRANSACIONAL-2026-11-22.md`). Esta rodada fechou os
**resíduos** que impediam declarar o bloco concluído: janelas de perda de
compensação, retomada de claims e o ciclo completo da operação externa de
repasse. Nenhuma entidade nova foi criada e nenhum campo foi removido.

---

## 2. Resíduos e o que foi corrigido

### P2-01 — Reserva de cupom: compensação recuperável

**Defeito:** a liberação da reserva (CAS `reserved → released`) e a devolução do
contador (`uses_count - 1`) eram dois passos. Uma interrupção entre eles deixava
o uso consumido para sempre, sem que ninguém soubesse que faltava devolver.

**Correção:** o cupom passou a ter um **ledger** no próprio documento
(`reserved_reservation_ids` / `released_reservation_ids`). O decremento é
`$inc -1` + `$addToSet` do ID + `$pull` do ledger de incremento **na mesma
escrita**, condicionado a `released_reservation_ids: { $ne: id }`. Repetir é
no-op; a reconciliação (`expireStaleReservations`) varre `counter_state` pendente
e devolve o que ficou para trás, sem decremento duplo. Reservas cuja devolução é
responsabilidade do marcador do pedido ficam `handled_by_order` e são excluídas
da varredura.

**Evidência:** `tests/unit/p2-01-coupon-reservation.test.mjs` — 31 testes.

### P2-03 — Reativação de identidade: trilha durável antes da mutação

**Defeito:** a reativação de uma `Person` inativa era aplicada antes de a trilha
existir. Uma falha de auditoria deixava a reativação feita e sem evidência — e
sem como retomar.

**Correção:** a **intenção** de trilha é gravada (e confirmada por leitura) antes
do CAS de reativação; a conclusão é idempotente. Queda depois do CAS é
recuperada pela trilha pendente, e a operação nunca conclui sem evidência.
Anonimizados (`is_anonymized`) nunca são reativados nem reutilizados: quem volta
com o mesmo e-mail recebe identidade nova.

**Evidência:** `tests/unit/p2-03-person-identity.test.mjs` — 19 testes.

### P2-06 — Avaliação de case: exclusão mútua real e retomada por lease

**Defeito:** `filter → create` não garante unicidade: dois requests simultâneos
liam "não existe" e ambos criavam, inflando a nota do case.

**Correção:** a exclusão mútua é um **CAS no documento da submissão**
(`evaluation_claims: { $ne: reviewer }` + `$addToSet`) — atômico, em documento
que sempre existe. O `EvaluationClaim` guarda token e validade (lease de 60 s):
o proprietário se identifica (fencing token gravado em `AwardEvaluation.claim_token`),
e um claim abandonado por crash é **retomado por CAS no token anterior**, de modo
que exatamente uma execução passa a ser proprietária. A liberação é `$pull`
idempotente; quem perde recebe `claim_busy` (HTTP 409, retryável) e nada grava.

**Dois defeitos encontrados e corrigidos nesta rodada:**

1. A renovação do lease acontecia **antes** de saber se o slot era nosso —
   destruindo token e validade do proprietário atual e abrindo duas escritas
   simultâneas. Agora o proprietário vivo é detectado primeiro e não é tocado.
2. O retorno devolvia o estado em memória (`intent_recorded`) em vez do estado
   persistido, e a transição `local_applied` era rejeitada pelo CAS por sair de
   um estado não permitido — a operação ficava `provider_confirmed` com
   `local_applied: false`.

**Evidência:** `tests/unit/p2-06-evaluation-integrity.test.mjs` — 25 testes
(inclui lease vencido, interleaving controlado, crash do proprietário,
concorrência tripla, claim indisponível e 409 no caminho HTTP).

### P2-08 — Repasse: ciclo durável da operação externa

**Defeito:** a trilha registrava apenas "solicitada". Não havia prova do
desfecho: falha após a intenção, confirmação do provedor com gravação local
falha, ou timeout (resultado **desconhecido**, que não é falha nem sucesso)
deixavam estado local e externo divergentes em silêncio.

**Correção:** `PayoutOperation` percorre
`intent_recorded → provider_confirmed | provider_failed | reconciliation_required | divergent`:

- `operation_id` estável e `idempotency_key` **determinística** (conta + valor em
  centavos, nunca horário);
- intenção gravada **antes** de qualquer efeito externo, e trilha da intenção
  obrigatória — sem ela o provedor não é chamado;
- o provedor devolve três desfechos distintos (`confirmed` / `failed` / `unknown`);
  `unknown` (timeout, rede, 5xx) vira `reconciliation_required`, nunca falha;
- só `provider_confirmed` aplica o estado local, e o local só é dado como
  aplicado depois de **confirmado por leitura**;
- a reconciliação reenvia a **mesma** requisição com a **mesma** chave (nenhum
  efeito duplo) e, quando a referência do provedor já existe, conclui apenas o
  lado local;
- conflito de idempotência vira `divergent` (revisão humana, nunca nova tentativa
  automática);
- falha da trilha de conclusão fica como caso **pendente durável**
  (`audit_pending`), concluído por `resolvePendingTrails`.

**Evidência:** `tests/unit/p2-08-payout-reserve-audit.test.mjs` — 19 testes
(valor válido, ordem intenção→trilha→provedor, entradas inválidas, zero,
trilha indisponível, recusa 4xx, timeout, 5xx, conflito de idempotência,
confirmação com local falho, replay sem segundo POST, valor diferente,
FIN-003 e cinco cenários de reconciliação).

---

## 3. Verificação executada

| Suíte | Testes | Resultado |
|---|---|---|
| `test:unit:p2` (P2-01/02/03/04/06/08) | 125 | 125 passam |
| `test:unit:refund` | 115 | 115 passam |
| `test:unit:f4` | 70 | 70 passam |
| `test:unit:certhttp` | 65 | 65 passam |
| `test:unit:fase3` | 35 | 35 passam |
| `test:unit:p1` | 31 | 31 passam |
| `test:unit:migration` | 25 | 25 passam |
| `test:unit:roleintegrity` | 15 | 15 passam |
| `test:unit:authz` | 13 | 13 passam |
| `test:unit:csv` | 12 | 12 passam |
| `test:unit:security` | 9 | 9 passam |
| `test:unit:auditlog` | 9 | 9 passam |
| `test:unit:deletion` | 9 | 9 passam |
| `test:unit:certaudit` | 8 | 8 passam |
| `test:unit:access` | 7 | 7 passam |
| **Total** | **548** | **548 passam, 0 falhas** |

- `npm run build` — conclui sem erros.
- `npm run lint` — sem avisos.
- `npm run typecheck` — apenas os erros **pré-existentes** do frontend
  (`src/pages/**`, `src/components/**`, incluindo o conhecido em
  `ValidaCertificado.jsx`). Nenhum erro em `base44/` — o escopo do typecheck nem
  inclui essa árvore; os módulos compartilhados são validados pelos testes.

Arquivos tocados nesta rodada: `base44/shared/payoutOperation.ts`,
`tests/unit/p2-06-evaluation-integrity.test.mjs`,
`tests/unit/p2-08-payout-reserve-audit.test.mjs`.

---

## 4. Limitações declaradas

1. **Sem transação entre documentos.** A plataforma não oferece transação
   multi-documento. Todas as garantias acima vêm de CAS por documento + ledger
   no próprio documento afetado + reconciliação idempotente. Não há atomicidade
   distribuída: há **exatamente-uma-vez recuperável**.
2. **Lease, não lock distribuído.** O claim de avaliação expira em 60 s. Uma
   execução que leve mais que isso pode ser retomada por outra; o fencing token
   identifica a execução proprietária, e a nota é deduplicada por
   `(submission_id, reviewer_user_id)` como rede de segurança.
3. **Reconciliação é periódica.** Operações `reconciliation_required` só
   concluem na próxima execução do job de manutenção; a janela de tolerância de
   2 min protege requisições ainda em curso.
4. **Testes usam dobra de banco e provedor.** `tests/unit/lib/fakeDb.mjs` e o
   stub de `fetch` replicam a semântica de CAS e os códigos do provedor. Não
   houve teste contra Stripe real nem carga concorrente em banco real (a infra de
   testes não está acessível a partir deste ambiente).
5. **Triagem de dependências pendente.** As 27 vulnerabilidades de dependência
   seguem fora deste escopo.

---

## 5. Declaração

Nada foi publicado e nenhuma migração de dados foi executada. A verificação é
local (suítes unitárias, build, lint, typecheck). As funções `managePayouts`,
`manageAward` e `expireStaleReservations` mantêm as assinaturas e os códigos de
status anteriores, com dois desfechos novos e explícitos no repasse: **503 com
`reconciliation: "automatic"`** (desfecho desconhecido, não concluído) e **409
com `reconciliation: "manual"`** (conflito de idempotência).
