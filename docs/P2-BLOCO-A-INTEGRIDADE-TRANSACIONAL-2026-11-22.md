# P2 — Bloco A: integridade transacional e de dados

**Data:** 2026-11-22
**Escopo:** seis defeitos de integridade transacional/de dados identificados na auditoria P2.
**Regra aplicada em todos:** a plataforma não oferece transação entre documentos, então cada garantia vive na **mesma escrita atômica** do documento que ela protege, ou em um **CAS explícito** com estado terminal. Nenhum caminho declara sucesso sem confirmação por leitura.

---

## Resumo executivo

| Item | Defeito | Correção | Testes |
|---|---|---|---|
| P2-01 | Uso de cupom consumido antes de o pedido existir → cupom esgotado sem pedido e sem origem | Entidade `CouponReservation` com ciclo `reserved → committed \| released` | 18 |
| P2-02 | Parser de assinatura Stripe guardava só a ÚLTIMA `v1` → webhook legítimo recusado na rotação de segredo | Parser preserva todas as `v1`; verificação aceita lista de segredos | 16 |
| P2-03 | Resolução de Person excluía cadastros inativos e podia reutilizar anonimizada (LGPD) | Três estados explícitos; reativação por CAS auditado; anonimizada nunca reutilizada | 12 |
| P2-04 | `Math.floor` / `Number(x) \|\| 1` transformavam entrada inválida em valor válido em silêncio | `parseQuantity` / `parseMoneyBRL`: entrada inválida é RECUSADA com motivo | 15 |
| P2-06 | `filter → create` na avaliação: duplo clique criava duas notas e inflava o score | Gravação convergente + dedupe determinístico em todo cálculo de score | 15 |
| P2-08 | `Math.max(0, Number(amount) \|\| 0)` na reserva de repasse, aplicada sem trilha obrigatória | Valor validado em centavos + trilha obrigatória ANTES do efeito externo | 10 |

**Total: 86 testes P2, 100% verdes.** Regressão: F4 70/70, estorno 115/115, P1 31/31, build e lint limpos.

---

## P2-01 — Ciclo de vida durável da reserva de cupom

**Defeito.** O checkout incrementava `Coupon.uses_count` **antes** de criar o `Order`. Se qualquer passo seguinte falhasse (criação do pedido, itens, cobrança, trilha), o uso ficava consumido sem nenhum pedido correspondente: o cupom esgotava artificialmente e não havia como descobrir a origem do consumo.

**Correção.** Nova entidade `CouponReservation` (admin-only, escrita só por backend) e `shared/couponReservation.ts`:

- cada tentativa de checkout gera **um** registro identificado por `checkout_token` gerado no servidor;
- estados terminais explícitos: `reserved` (uso consumido, pedido não confirmado), `committed` (venda confirmada — uso permanece), `released` (uso devolvido);
- a liberação é um **CAS no próprio registro** (`reserved → released`): exatamente uma execução devolve o uso, repetir é no-op, e nenhuma requisição libera a reserva de outra;
- `counter_reserved` / `counter_decremented` separam *quem* consumiu de *quem* devolveu — quando o marcador do pedido (`coupon_uses_counted`) já devolveu o uso, a reserva passa `counterHandledBy: "order"` e **não** decrementa de novo;
- cupons ilimitados registram a reserva sem consumir teto;
- reconciliação no job agendado classifica cada reserva (`sem_pedido`, `pagamento_confirmado`, `processando`, `indeterminado`, `ativo_no_provedor`, `pedido_encerrado`, `pedido_vivo`, `leitura_indisponivel`) e **nunca devolve uso sem prova de ausência de pagamento**.

**Garantia.** Não existe estado em que o uso esteja consumido sem registro que o explique; e não existe caminho que devolva o mesmo uso duas vezes.

**Integrações.** `createPaymentIntent` (reserva), `commerceFulfillment` (confirmação no pagamento, liberação na falha/estorno), `expireStaleReservations` (reconciliação).

**Testes — `tests/unit/p2-01-coupon-reservation.test.mjs` (18).** Consumo e registro; idempotência por token; cupom esgotado; cupom ilimitado; liberação exatamente-uma-vez; venda confirmada não liberada por engano; estorno sem decremento duplo; encerramento por pedido; reconciliação (órfã vencida/válida, pago, Pix em processamento, provedor indisponível, pedido encerrado, pedido vivo, pedido vencido não antecipa o expirador, leitura indisponível); diagnóstico de legado sem escrita.

---

## P2-02 — Assinatura do webhook Stripe com múltiplas `v1`

**Defeito.** O parser guardava apenas a **última** ocorrência de `v1` no header. Com rotação de segredo — ou qualquer header em que a assinatura válida não fosse a última — um webhook **legítimo** era recusado com 400 e o pagamento só era reconciliado pelo polling.

**Correção.** `shared/stripeSignature.ts`:

- `parseStripeSignature` preserva **todas** as `v1` (e ignora esquemas desconhecidos, como `v0`);
- `verifyStripeSignature` aceita **um segredo ou uma lista** (novo + anterior) e casa qualquer par (segredo, `v1`);
- verificação sobre os **bytes originais** do corpo (nada é reserializado), janela de tolerância de 300 s, comparação em tempo constante, recusa explícita quando não há segredo configurado;
- motivos distintos para diagnóstico: `header_malformado`, `assinatura_ausente`, `sem_assinatura_v1`, `timestamp_invalido`, `timestamp_conflitante`, `timestamp_fora_da_janela`, `assinatura_invalida`, `segredo_ausente`.

**Garantia.** Rotação de segredo não derruba a entrega; payload adulterado continua recusado; falta de configuração falha fechada.

**Integrações.** `stripeWebhook` (via `constructStripeEvent`).

**Testes — `tests/unit/p2-02-stripe-signature.test.mjs` (16).** Assinaturas calculadas com `node:crypto` (implementação independente): v1 única, múltiplas, válida-primeira/inválida-última (o defeito original), válida-última, todas inválidas, rotação, payload adulterado, timestamp alterado/expirado/futuro, headers malformados, esquemas desconhecidos, espaços, segredo ausente, comparação de hex e replay.

---

## P2-03 — Estados da identidade (LGPD) na resolução de Person

**Defeito.** A busca por e-mail filtrava `is_active: { $ne: false }` — cadastros **inativos** nunca apareciam — e o ramo que deveria reativá-los era código morto. Quem tinha cadastro desativado ganhava uma **segunda** Person ao comprar de novo, dividindo pontos, certificados e histórico. Pior: nada impedia reativar uma Person **anonimizada**, desfazendo uma exclusão LGPD.

**Correção.** `shared/personResolution.ts` com três estados explícitos (`active`, `inactive`, `anonymized`):

- ativa → reutilizada;
- inativa → **reativada por CAS** (`is_active: false` + `is_anonymized: { $ne: true }` → `true`) com trilha `person_reactivated` (ator, evento, motivo);
- anonimizada → **nunca** reutilizada nem reativada: quem volta recebe identidade **nova**, e o registro anonimizado permanece intocado;
- falha de leitura é **recusa** (`lookup_unavailable`), nunca criação de duplicata;
- corrida de criação converge para o sobrevivente determinístico `(created_date, id)`: o excedente é desativado (nunca apagado) com trilha `person_duplicate_converged`;
- CAS perdido devolve `reactivation_conflict` em vez de criar uma segunda Person.

**Garantia.** Um e-mail tem no máximo uma identidade reutilizável, e uma exclusão LGPD é irreversível por desenho.

**Integrações.** `commerceFulfillment` (titular do ingresso), `getOrCreatePerson`, `deleteMyAccount` (marca `is_anonymized`).

**Testes — `tests/unit/p2-03-person-identity.test.mjs` (12).** Classificação; busca incluindo inativas; reutilização; reativação com trilha; anonimizada gera identidade nova e não é reescrita; criação com `created_day`; idempotência; falha de leitura; falha de criação; conflito de CAS; convergência de corrida; e-mail inválido.

---

## P2-04 — Quantidade inteira e valor monetário estritos

**Defeito.** `Math.floor(1.5)` → 1, `Math.max(1, Number(x) || 1)` e `parseInt(x) || 1` **transformavam entrada inválida em valor válido** em silêncio: o erro do cliente (ou do atacante) deixava de existir, e o número gravado não era o número enviado.

**Correção.** `shared/numericInput.ts`:

- `parseQuantity`: aceita inteiro finito ou texto de dígitos; recusa NaN, infinitos, fracionário, negativo, zero (quando exige positivo), vazio, texto com letras/`1e3`/`0x10`, booleano, objeto e valor acima do limite — **cada recusa com motivo**;
- `parseMoneyBRL`: converte em **centavos por aritmética inteira** (nunca `valor * 100` em ponto flutuante), aceita vírgula, recusa mais de duas casas (`precisao`), negativos e acima do limite de negócio;
- `Math.floor` foi removido de `stockReservation`: quantidade fracionária não é truncada para um valor "válido" — é recusada, e nenhum saldo se move.

**Garantia.** O número gravado é sempre o número enviado; entrada inválida não vira default.

**Integrações.** `stockReservation` (reserva e liberação), `createPaymentIntent`, `executeRaffle`, `managePayouts`.

**Testes — `tests/unit/p2-04-quantity.test.mjs` (15).** Matriz de aceitação/recusa de quantidade e dinheiro + integração: demanda fracionária recusada sem mover saldo nem criar registro; acima do estoque; corrida pelo último item; liberação fracionária não devolve estoque; liberação inteira idempotente.

---

## P2-06 — Uma avaliação lógica por (submissão, avaliador)

**Defeito.** `manageAward.saveEvaluation` fazia `filter → create`. Duas requisições simultâneas (duplo clique, retry do cliente, duas abas) liam "não existe" ao mesmo tempo e criavam **duas** avaliações: o score era somado duas vezes, distorcendo média e ranking.

**Correção.** `shared/evaluationIntegrity.ts`:

- `saveEvaluationOnce`: lê as avaliações do par, **atualiza a sobrevivente determinística** quando existe e só cria quando não existe; duplicatas pré-existentes são encerradas (`is_deleted`) e o número é devolvido (`duplicatesRemoved`);
- `groupEvaluationsByReviewer` / `dedupeEvaluationsForScoring`: **todo** cálculo de score/ranking deduplica por par, com desempate estável `(created_date, id)` — a mesma resposta para qualquer ordem de leitura;
- falhas devolvem estado explícito (`read_unavailable`, `create_failed`, `update_failed`, `create_unconfirmed`), nunca lançam.

**Garantia.** Duplicata deixada por corrida **não** infla score; retry converge para o mesmo registro.

**Integrações.** `manageAward` (saveEvaluation e cálculo de ranking).

**Testes — `tests/unit/p2-06-evaluation-integrity.test.mjs` (15).** Agrupamento e sobrevivente; estabilidade independente da ordem; desempate por id; score com duplicatas não soma duas vezes; criação/atualização; convergência de duplicatas pré-existentes; falhas; e caminho HTTP (`403` fora da banca, critério inexistente, nota negativa/acima do máximo/não numérica, premiação sem critérios, case de outro evento, total ponderado, reenvio sem duplicar).

---

## P2-08 — Reserva de repasse: valor validado e trilha obrigatória

**Defeito.** `setReserve` usava `Math.max(0, Number(amount) || 0)`: `"abc"` → 0, `NaN` → 0, `-5` → 0. A alteração era aplicada no Stripe e no registro local **sem trilha obrigatória** — sem saber quem alterou, qual era o valor anterior nem o motivo.

**Correção.** `managePayouts`:

- valor passa por `parseMoneyBRL` (finito, não negativo, até 2 casas, limite de negócio) e vira **centavos** por aritmética inteira; inválido → `400` com `field: "amount"` e **nada** acontece;
- **trilha obrigatória antes do efeito externo** (`trailPayoutChange` → `writeMandatoryAudit`): ator, evento, conta, valores anterior/novo, moeda, motivo, `correlation_id` e `resultado`. Sem trilha confirmada → `503` e nenhum efeito no provedor;
- chave determinística da trilha: o retry da **mesma** operação reconhece a trilha existente em vez de duplicá-la;
- estado local confirmado por **leitura** depois da escrita (resposta otimista não é prova de persistência);
- falha do provedor → `502` com o valor local intacto e a tentativa registrada.

**Garantia.** Nenhum valor financeiro muda sem evidência correspondente, e nenhuma entrada inválida é silenciosamente convertida em zero.

**Integrações.** `managePayouts` (`setReserve`; a mesma primitiva de trilha já cobre comissão e vínculo de conta).

**Testes — `tests/unit/p2-08-payout-reserve-audit.test.mjs` (10).** Valor válido com centavos e trilha completa; **ordem** trilha-antes-do-provedor; recusa de `"abc"`, `-5`, `12.345`, `""`, `undefined`, `NaN` sem tocar o provedor; zero válido; trilha indisponível bloqueia (`503`); falha do provedor (`502`, valor intacto, trilha registrada); retry sem duplicar trilha; valor diferente gera trilha própria; equipe (não financeiro) barrada (`403`, FIN-003); sem conta conectada (`404`).

---

## Regressão e verificação

```
npm run test:unit:p2      → 86 testes, 86 pass
npm run test:unit:f4      → 70 testes, 70 pass
npm run test:unit:refund  → 115 testes, 115 pass
npm run test:unit:p1      → 31 testes, 31 pass
npm run build             → exit 0
eslint (módulos P2)       → limpo
```

Infraestrutura de teste reutilizada/estendida: `tests/unit/lib/fakeDb.mjs` (novas coleções `CouponReservation`, `AwardEvaluation`, `AwardSubmission`, `PayoutAccount` e `collection` exportada), `tests/unit/lib/fakeHttpClient.mjs` (cliente HTTP falso com injeção de falha por operação).

---

## Riscos residuais (declarados)

1. **Corrida de criação de avaliação** — sem índice único na plataforma, duas requisições simultâneas ainda podem criar dois registros. O efeito no score é neutralizado pelo dedupe, e a próxima gravação converge encerrando o excedente. A janela não distorce mais média nem ranking.
2. **Reserva de cupom órfã sem pedido** — permanece viva até o vencimento (15 min) e é encerrada pela reconciliação; nunca devolve uso de pedido vivo.
3. **Reativação de Person inativa** — a trilha é best-effort (`audited: false` quando indisponível), mas a reativação em si é CAS e idempotente: uma falha de trilha não cria duplicata nem desfaz a identidade.
4. **Cupons legados** — pedidos anteriores ao ciclo de vida não têm reserva; `diagnoseLegacyCouponOrders` apenas diagnostica, nunca apaga. O marcador do pedido continua sendo a autoridade do contador para eles.

---

## Arquivos

**Novos:** `base44/entities/CouponReservation.jsonc`, `base44/shared/couponReservation.ts`, `base44/shared/numericInput.ts`, `base44/shared/stripeSignature.ts`, `base44/shared/evaluationIntegrity.ts`, `tests/unit/lib/fakeHttpClient.mjs`, as seis suítes `tests/unit/p2-*.test.mjs`.

**Alterados:** `base44/shared/personResolution.ts`, `base44/shared/commerceFulfillment.ts`, `base44/shared/stockReservation.ts`, `base44/shared/stripeClient.ts`, `base44/functions/createPaymentIntent/entry.ts`, `base44/functions/expireStaleReservations/entry.ts`, `base44/functions/manageAward/entry.ts`, `base44/functions/managePayouts/entry.ts`, `base44/functions/deleteMyAccount/entry.ts`, `base44/entities/Order.jsonc`, `base44/entities/Person.jsonc`, `package.json`.
