# Fase 2 — Relatório consolidado (2026-11-12)

**Base:** branch `main`, HEAD inicial `75072d1` (árvore limpa no início).
**Final:** alterações em working tree, não commitadas — 11 arquivos modificados, 5 novos.
**Regra respeitada:** nada de deploy, nenhum dado de produção alterado, nenhum e-mail enviado,
nenhuma operação financeira real. A migração de dados foi escrita mas **não executada**.

---

## 1. Tabela consolidada

| ID | Prioridade | Frente | Problema confirmado | Correção realizada | Arquivos | Testes | Status | Pendência |
|---|---|---|---|---|---|---|---|---|
| F2-01 | P0 | 2.1 Session/Track | Não havia. `Session` e `Track` já são negadas para o SDK (`read` admin-only) e a leitura legítima passa por funções que validam vínculo **por evento** | Nenhuma alteração (evidência: `getEventSessions` valida `EventMembership`/`Participant` de cada `eventId`; `getEventTracks` idem) | — | Adversarial E2E **não executado** | Já corrigido (validado por leitura de código) | Rodar suíte adversarial por perfil e os 2 staffs pendentes (ver §4) |
| F2-02 | P0 | 2.2 RLS demais entidades | Auditoria das 43 entidades: **nenhuma** sem RLS; **uma** com escrita indevida — `NotificationRecipient.update` aceitava o próprio destinatário | `update` → admin-only; marcação de leitura/clique movida para backend | `NotificationRecipient.jsonc`, `manageNotificationCampaign`, `NotificationDetailModal.jsx` | Lint + build | Corrigido | Validação adversarial de RLS na base real |
| F2-03 | P0 | 2.3 Operações sensíveis | Nada novo: pontuação, resgates, premiação, sorteio e certificados já são service-role + RLS admin-only (Fase 1 preservada) | Nenhuma alteração | — | Suíte de estornos 115/115 | Já corrigido | — |
| F2-04 | P1 | 3.1 Autorização no disparo | Não havia: revalidação **existe** no disparo manual (`dispatchNotificationCampaign:42`), na varredura agendada (`expireStaleReservations:976`) e no agendamento (`manageNotificationCampaign:146`) | Nenhuma alteração | — | — | Já corrigido | Teste E2E de campanha agendada após revogação de papel |
| F2-05 | P1 | 3.2 NotificationRecipient | Destinatário podia escrever no próprio registro: falsificar `delivery_status`/`delivered_at`, marcar clique inexistente, apontar para outra campanha e reescrever e-mail/nome | `update` admin-only; novas ops `mark_read` (aceita `recipient_id`) e `mark_clicked`, com flip condicional e âncora em `user.id` | `NotificationRecipient.jsonc`, `manageNotificationCampaign/entry.ts`, `NotificationDetailModal.jsx` | Lint + build | Corrigido | E2E: usuário marca leitura e não consegue forjar `delivered_at` |
| F2-06 | P1 | 3.3 Idempotência/lotes | Nada novo: despacho em lotes com `scanBatches`, claim de campanha, `auto_dispatch_attempts` e retomada existem | Nenhuma alteração | — | — | Já corrigido | — |
| F2-07 | P1 | 4.1 Event / DTOs | **Confirmado:** `Event.read` permite a qualquer usuário autenticado ler eventos `active/finished`, incluindo `commission_percent`, `payout_account_id`, `refund_policy` e `coupon_codes_registry` (os códigos de cupom eram descobríveis) | Campos movidos para entidade **`EventFinance`** (RLS admin-only) com `withEventFinance` (sem escrita na leitura) e fallback legado; escritas migradas em commerce, payouts, checkout, estorno e PDF; migração idempotente disponível | `EventFinance.jsonc`, `shared/eventFinance.ts`, `migrateEventFinance/entry.ts`, `manageCommerce`, `managePayouts`, `createPaymentIntent`, `requestRefund`, `shared/ticketPdf.ts` | Build + lint + suíte de estornos | **Corrigido em código; exposição fechada só após a migração** | Executar `migrateEventFinance` (dry-run primeiro) — altera dados, exige sua autorização |
| F2-08 | P1 | 4.2 getMyLeads | Não havia: já tem autorização de parceiro, cursor, teto 200, `count` no servidor e projeção de campos | Nenhuma alteração | — | — | Já corrigido | — |
| F2-09 | P1 | 4.3 LGPD | PII já minimizada (CPF/telefone fora das listas para não-gestão) e `deleteMyAccount` existe; retenção/anonimização não é decisão técnica | Nenhuma alteração | — | — | Parcial | Decisão jurídica de prazo de retenção e base legal |
| F2-10 | P1 | 4.4 AuditLog | Já é admin-only nas quatro operações; transições financeiras usam trilha obrigatória com chave determinística | Nenhuma alteração | — | — | Já corrigido | — |
| F2-11 | P1 | 5.1 PDFs/SSRF | Já existe `safeImageFetch` (só HTTPS, bloqueio de host interno, resolução DNS validada, teto de dimensão) | Nenhuma alteração | — | — | Já corrigido | — |
| F2-12 | P1 | 5.2 URLs externas | Já existe sanitização (`javascript:`, `data:`, `on*`) em `src/utils/sanitize.js` | Nenhuma alteração | — | — | Já corrigido | Revisar CTAs novos que não passem pelo util |
| F2-13 | P1 | 5.3 Webhooks | **Confirmado:** `payment_intent.succeeded` emitia ingresso sem conferir **valor** e **moeda** do que foi cobrado | `assertPaymentMatchesIntent` + bloqueio antes do fulfillment: trilha obrigatória `pagamento_divergente`, pagamento não confirmado, nada emitido, 200 sem reenvio | `shared/paymentMatch.ts`, `stripeWebhook/entry.ts`, `tests/unit/payment-match.test.mjs` | 9/9 novos testes + suíte de estornos | Corrigido | E2E de webhook com valor divergente |
| F2-14 | P2 | 6.1 Listagens | **Confirmado:** `/people` carregava `User.list()` (coleção inteira) só para desenhar o selo das 20 linhas visíveis | Consulta restrita aos ids da página (`$in`, teto 50) | `AdminPeoplePlaceholder.jsx` | Lint + build | Corrigido | Demais listagens já paginadas (ver §5) |
| F2-15 | P2 | 6.2 BusinessDashboard | Já usa `MetricBucket` materializado (fonte única, `scanBatches`) | Nenhuma alteração | — | — | Já corrigido | — |
| F2-16 | P2 | 7.1 Dependências | Não verificado: `npm audit` indisponível neste ambiente | Nenhuma atualização (sem evidência de exploração e sem rede) | — | **Não executado** | Pendente | Rodar `npm audit` e atualizar só o que tiver risco real |
| F2-17 | P2 | 7.2 SDK | **Confirmado:** 91 funções em `npm:@base44/sdk@0.8.54`, frontend em `^0.8.60` | Não alterado: mesmo minor (0.8), sem sintoma de incompatibilidade; mudar 91 arquivos sem evidência é churn de risco | — | — | Documentado | Se houver sintoma, padronizar em um commit próprio |
| F2-18 | P2 | 7.4 ESLint/TS | `base44/**/*.ts` **já** está no ESLint (parser TS, sem `no-undef`) | Nenhuma alteração | — | ESLint dos arquivos alterados: **0 erros**, 1 warning pré-existente (`STATUS_LABELS` em `NotificationDetailModal`) | Já corrigido | — |
| F2-19 | P2 | 7.5 Testes/observabilidade | Sem sinal novo; webhooks divergentes agora geram trilha obrigatória consultável | Nova suíte `test:unit:security` | `package.json` | Ver §3 | Corrigido (parcial) | Alertas automáticos para `pagamento_divergente` e `refundsBlocked` |

---

## 2. O que mudou de fato

1. **NotificationRecipient (P1)** — a escrita do destinatário foi fechada. A caixa de notificações
   continua funcionando porque leitura e clique passam pelo backend, que ancora o registro no
   usuário autenticado e faz flip condicional (exatamente um vencedor).
2. **Webhook de pagamento (P1)** — valor e moeda do PaymentIntent passaram a ser conferidos contra
   o `Payment` gravado. Divergência não confirma o pagamento, não emite ingresso, não libera
   reserva e deixa trilha obrigatória com os dois valores.
3. **Campos internos do Event (P1)** — comissão, conta recebedora, política de estorno e registro
   de códigos de cupom saíram do contrato de leitura pública do evento e passaram para
   `EventFinance` (admin-only). Nada quebra antes da migração por causa do fallback legado.
4. **Listagem de pessoas (P2)** — deixa de carregar a coleção inteira de usuários.

## 3. Testes executados

| Comando | Resultado |
|---|---|
| `npm run test:unit:refund` (Fase 1: ledger, correlação, conclusão, estoque) | **115/115 pass** |
| `npm run test:unit:security` (novo: identidade valor/moeda do webhook) | **9/9 pass** |
| `npm run build` | **exit 0** |
| `npx eslint` nos 11 arquivos alterados | **0 erros** (1 warning pré-existente) |

## 4. Testes NÃO executados (e por quê)

- **Suíte adversarial RLS por perfil (Participant, Speaker, Partner, Manager/Staff, Admin)** —
  exige browser e contas reais; o ambiente não permite. O que foi verificado é a *regra* e o
  *caminho de código*, não o comportamento em produção.
- **Os dois usuários Staff pendentes, smoke e regressão estável** — mesma limitação.
- **Reconnect e load** — continuam classificados como **teste de infraestrutura**, não como
  aprovados (não foram executados nesta rodada).
- **`npm audit`** — sem acesso a registry neste ambiente.

## 5. Riscos residuais

1. **Exposição do Event continua até a migração rodar.** O código já não escreve nem lê os campos
   legados como fonte primária, mas os valores antigos seguem gravados no `Event` e legíveis por
   usuário autenticado. Fechar isso é `migrateEventFinance` com `dry_run: false` (altera dados —
   depende da sua autorização).
2. **Cobrança divergente bloqueia a venda até resolução manual** — é o comportamento desejado
   (não emitir ingresso por valor não cobrado), mas exige alguém olhando a trilha.
3. **Notificação de leitura por `recipient_id`**: se o registro não pertencer ao usuário, a função
   responde 404 — comportamento correto, porém silencioso na UI (o modal já trata o erro).
4. **SDK em 0.8.54 nas funções**: dívida registrada, não corrigida por falta de sintoma.

## 6. Confirmações

- Nenhum deploy, nenhuma publicação.
- Nenhum dado de produção alterado (a migração foi escrita, não executada).
- Nenhum e-mail real enviado, nenhuma operação financeira executada.
- Fase 1 intacta: a suíte de estornos continua 115/115 e nenhum arquivo do ledger, da correlação
  ou do retorno de estoque foi modificado nesta rodada.
