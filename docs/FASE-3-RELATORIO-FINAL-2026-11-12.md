# Fase 3 — Auditoria e Execução Integral (3.1 a 3.5) — 2026-11-12

> **Natureza deste documento:** relatório de execução com evidências classificadas. Não declara o
> aplicativo "seguro" em termos absolutos. Nenhuma etapa é declarada concluída sem que seus
> critérios de aceite tenham sido atendidos **e validados**; quando a validação depende de
> navegador, contas reais ou concorrência real, a etapa é registrada como **parcialmente validada**.

---

## 1. Resumo executivo

- **3.1 (Session/Track)** foi preservada integralmente (correções, 13 testes, build, lint). Nenhum
  arquivo da 3.1 foi reaberto.
- **E2E pendentes da 3.1:** tentados. O ambiente não tem estados de autenticação
  (`tests/.auth/*.json`) nem credenciais de seed, então 6 testes falharam **na preparação**
  ("No auth token in tests/.auth/<papel>.json") e 51 foram ignorados. **1 teste E2E real executou
  contra a borda publicada e passou:** chamada anônima a `expireStaleReservations` é bloqueada
  (401/403), sem mutação financeira. Os **dois casos de Staff continuam pendentes**.
- **3.2 a 3.5** foram executadas por inspeção de código ponta a ponta (função → autorização →
  consulta → persistência → efeito colateral) e com dados sintéticos.
- **5 correções aplicadas** (3 de segurança/privacidade, 1 de auditoria, 1 de documentação de
  segurança), todas com regressão: **171 testes unitários aprovados**, build e ESLint limpos.
- **Nenhum P0 novo** foi reproduzido. Cinco achados P2/P3 foram corrigidos; oito itens foram
  verificados e considerados corretos; seis pendências foram documentadas (três dependem de
  decisão de negócio/jurídica, três de infraestrutura).
- **Nenhum deploy, publicação, migração, envio real, cobrança ou escrita em dados de produção**
  foi realizado (§16).

## 2. Commits

| | Valor |
|---|---|
| Commit inicial desta rodada | `e918e56d8a0c3303be0a2918cc015c1f89d75327` — "Implementar validação rigorosa por valor em confirmFinancePersisted" (2026-11-12 20:20:58 +0000) |
| Commit final | Criado pela plataforma ao gravar esta rodada. O ambiente bloqueia `commit`/`push` do agente para não reescrever histórico; o hash deve ser lido no histórico do app. O diff exato está em §10. |
| Base vista pelo editor | Produção (nenhuma escrita de dados foi feita — §16) |

## 3. Escopo executado

| Etapa | O que foi feito nesta rodada | Status |
|---|---|---|
| 3.1 | Preservada; tentativa de E2E pendente e 1 teste real aprovado | **Parcialmente validada** |
| 3.2 | Inventário de 100% das funções por varredura + revisão profunda de 12 funções sensíveis | **Parcialmente validada** |
| 3.3 | Inventário dos caminhos de campanha + verificação de revalidação, claim, dedup e retomada | **Parcialmente validada** |
| 3.4 | Auditoria de `AuditLog`/`logAuditEvent`/`auditTrail`; 2 correções + 9 testes | **Parcialmente validada** |
| 3.5 | Inventário de PII por entidade; 1 correção + 4 testes; decisões separadas | **Parcialmente validada** |

## 4. Inventário examinado

**Funções revisadas em profundidade (12):** `logAuditEvent`, `issueCertificate`,
`processScoringAction`, `executeRaffle`, `manageParticipant`, `manageEventRole`,
`getPaymentStatus`, `getTicketPdf`, `getTransactionTrail`, `getEventTickets`,
`deleteMyAccount`, `dispatchNotificationCampaign` + `shared/campaignDispatch.ts`.

**Funções verificadas por varredura de portas de autorização (todas as 90):** presença de guard de
conta ativa, gate de papel e gate de escopo. Resultado em §6 (V-*).

**Módulos compartilhados:** `accountSecurity`, `eventAuth`, `campaignAuth`, `campaignDispatch`,
`campaignAudience`, `auditTrail`, `identity`, `participantOwnership`, `anonymization` (novo),
`eventFinance*`, `refund*`, `commerceFulfillment`.

**Entidades (RLS + campos sensíveis):** Session, Track, Participant, Person, PersonDocument,
EventMembership, NotificationCampaign, NotificationRecipient, AuditLog, Certificate,
Submission, AwardSubmission, JobPosting, Ticket, Order, Payment, RefundRequest, EventFinance,
SalesLot.

**Fluxos:** disparo de campanha (manual e agendado), emissão de certificado, pontuação,
sorteio, exclusão de conta, download de ingresso, polling de pagamento, consulta de trilha
financeira.

## 5. Achados corrigidos

| ID | Etapa | Prioridade | Achado | Evidência de origem |
|---|---|---|---|---|
| F3-07 | 3.5 | P2 | Autoria de proposta (CFP), de case (premiação) e de vaga guarda snapshot de nome e e-mail que **sobrevivia à exclusão de conta** | Campos `submitter_name`/`submitter_email` em `Submission`/`AwardSubmission` e `poster_name`/`contact_email` em `JobPosting`; `deleteMyAccount` não os tocava |
| F3-08 | 3.4 | P2 | Qualquer **participante** do evento conseguia gravar entradas na trilha de auditoria (`status_change`, `role_change`) de ações que não executou | `logAuditEvent` usava `canAccessEventData` (inclui participante); `AuditLog` é admin-only por RLS, então a função era o vetor de escrita |
| F3-09 | 3.4 | P2 | **Emissão de certificado sem trilha** — única operação crítica do evento sem registro de auditoria | `issueCertificate` criava `Certificate` e retornava, sem `AuditLog` |
| F3-10 | 3.3 | P3 | Comentário de cabeçalho do núcleo de campanhas afirmava que o disparo agendado **não revalida** o emissor (contradizendo o código, que revalida) — documentação de segurança enganosa | `shared/campaignDispatch.ts` linhas 5–7 versus `expireStaleReservations` (importa `verifyCampaignSenderAuthorization`) |

## 6. Itens verificados e considerados corretos (sem alteração)

| ID | Item verificado | Resultado |
|---|---|---|
| V-01 | Disparo de campanha revalida emissor **no momento do envio** (manual e agendado) | Correto: `verifyCampaignSenderAuthorization` nos dois caminhos; emissor bloqueado grava `scheduled_dispatch_blocked` |
| V-02 | Audiência e escopo de campanha vêm do **banco**, não do cliente | Correto: campanha é relida por id; `senderPartnerId` só é aceito se autorizado |
| V-03 | Claim concorrente de campanha | Correto: CAS `updateMany(status ∈ draft/scheduled/partially_sent/failed → processing)`; perdedor recebe 409 |
| V-04 | Duplicidade de destinatário e retomada após falha | Correto: dedup por `recipient_user_id` dentro e entre lotes; `sent` é terminal; `failed`/`partially_sent` retomáveis |
| V-05 | `getSalesMetrics` / `getBusinessDashboardMetrics` | Corretos: **admin-only** (`requireActiveUser` + `role !== 'admin'`). (A varredura inicial os sinalizou por padrão de grep incompleto; a leitura do código corrigiu o falso positivo.) |
| V-06 | `getPaymentStatus` / `getTicketPdf` (IDOR em financeiro/ingresso) | Corretos: consulta escopada por `buyer_user_id`; PDF exige titular ou comprador |
| V-07 | `getTransactionTrail` (trilha financeira) | Correto: admin-only, resposta minimizada |
| V-08 | `manageParticipant` (escalada de privilégio) | Correto: gate único `manager/team` + porta própria do gerente para `team`/`manager`; `create` recusa papéis de gestão; troca de papel bloqueada quando há sessão vinculada |
| V-09 | `manageEventRole` (curador/avaliador) | Correto: **somente gerente** concede/revoga (não `team`), papéis em lista fechada |
| V-10 | `executeRaffle` (manipulação de universo/aleatoriedade) | Correto: pool resolvido no servidor por contexto, Fisher-Yates com `crypto.getRandomValues` sem viés de módulo |
| V-11 | `processScoringAction` (pontos indevidos) | Correto: evidência server-side por ação (presença, avaliação, pergunta ≥25 chars, lead, completude), identidade canônica, `personId` conferido, idempotência por chave + desempate determinístico |
| V-12 | `AuthContext`/`requireActiveUser` (conta excluída, inativa) | Correto: guard aplicado nas funções revisadas; conta excluída recebe 403 |

## 7. Evidência e cenários de reprodução

**Classificação de evidência por achado**

| Achado | Classificação |
|---|---|
| F3-07 | Confirmado por inspeção (campos existem e a função os ignorava) + teste unitário dos construtores de anonimização |
| F3-08 | Confirmado por inspeção (gate aceitava participante) — **não** reproduzido contra a base real |
| F3-09 | Confirmado por inspeção (ausência de `AuditLog`) + testes de trilha idempotente/falha explícita |
| F3-10 | Confirmado por leitura cruzada (comentário × código) |
| V-01…V-12 | Confirmado por inspeção |

**Cenários adversariais executados (unitários, banco simulado)**
- Gravar a mesma trilha duas vezes → segunda é duplicata, um único registro (`fase3` 6).
- Falha de escrita/leitura da trilha → `AuditUnavailableError` explícito, nada gravado parcial (`fase3` 7–8).
- Trilha sem chave de idempotência → recusada (`fase3` 9).
- Marcador de anonimização não é e-mail válido e não contém fragmento do nome original (`fase3` 1–4).
- Referência cruzada entre eventos em Session (3.1) → recusada (`authz` 1–9).
- Pagamento/estorno: concorrência, retomada, ledger, devolução de estoque (`refund` 115).

**Cenário E2E real executado (único possível no ambiente)**
| Cenário | Perfil | Recurso | Ação | Esperado | Obtido | Status |
|---|---|---|---|---|---|---|
| SR-1 | anônimo | borda publicada | invocar `expireStaleReservations` | 401/403, sem mutação | 401/403, sem mutação | **Aprovado** |

## 8. Impacto técnico e de negócio

- **F3-07:** sem correção, a pessoa que pedisse exclusão continuaria identificável por nome/e-mail
  em propostas, cases e vagas — descumprimento do direito de eliminação em dados de autoria.
- **F3-08:** a trilha é usada para investigar fraude e contestação. Um participante podia inserir
  eventos falsos na trilha do evento, contaminando a investigação e a defesa da organização.
- **F3-09:** certificado é documento com valor probatório; sem trilha não havia como provar quem
  emitiu, quando, para quem e com qual modelo.
- **F3-10:** documentação de segurança que afirma o contrário do código induz erro em auditorias
  futuras e em decisões de revisão de código.

## 9. Correções implementadas

1. **F3-08 — `logAuditEvent`**: escrita de trilha passa a exigir **gestão do evento**
   (admin, `manager` ou `team`) via `verifyEventMembership(..., EVENT_MANAGER_ROLES)`; sem
   `event_id`, continua exclusivo do admin. Leitura permanece admin-only pela RLS.
   *Nota de cobertura:* envio de campanha continua auditado no servidor pelo próprio núcleo
   (`dispatch_lock_acquired`), inclusive quando o emissor é parceiro.
2. **F3-09 — `issueCertificate`**: trilha obrigatória com chave determinística
   `certificado_emitido|<certificate_id>` (reexecução não duplica). Se a trilha falhar, o
   certificado já emitido é registrado como **trilha PENDENTE** (`recordPendingTrail`), reconciliada
   por `resolvePendingTrails` — nunca silenciada. O caminho de dedup passou a devolver o
   **sobrevivente** junto da trilha.
3. **F3-07 — `deleteMyAccount`**: novo passo 9d anonimiza `Submission`, `AwardSubmission` e
   `JobPosting` (por `person_id` e por variantes de e-mail normalizado), com contadores
   `submissions`, `awardSubmissions`, `jobPostings` no registro da exclusão. Marcadores e
   construtores extraídos para `shared/anonymization.ts` (fonte única).
4. **F3-10 — `shared/campaignDispatch.ts`**: comentário corrigido para refletir a revalidação real
   do emissor no disparo agendado.
5. **Testes**: `tests/unit/fase3-privacy-audit.test.mjs` (9 casos) e script `test:unit:fase3`.

## 10. Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `base44/functions/logAuditEvent/entry.ts` | gate de escrita da trilha: gestão do evento |
| `base44/functions/issueCertificate/entry.ts` | trilha obrigatória idempotente + retorno do sobrevivente |
| `base44/functions/deleteMyAccount/entry.ts` | passo 9d (autoria de CFP/premiação/vagas) + marcadores compartilhados |
| `base44/shared/anonymization.ts` | **novo** — marcadores e construtores de anonimização |
| `base44/shared/campaignDispatch.ts` | correção de comentário de segurança obsoleto |
| `tests/unit/fase3-privacy-audit.test.mjs` | **novo** — 9 testes (privacidade + auditoria) |
| `package.json` | script `test:unit:fase3` |
| `docs/FASE-3-RELATORIO-FINAL-2026-11-12.md` | este relatório (consolidado) |

Nenhuma entidade, regra RLS, workflow, secret ou integração foi alterada.

## 11. Testes executados e resultados

| Suíte | Tipo | Resultado |
|---|---|---|
| `test:unit:refund` (Fase 1) | unitário, banco simulado | **115/115** |
| `test:unit:security` (Fase 2) | unitário, banco simulado | **9/9** |
| `test:unit:migration` (Fase 2) | unitário, banco simulado | **25/25** |
| `test:unit:authz` (3.1) | unitário, banco simulado | **13/13** |
| `test:unit:fase3` (novo) | unitário, banco simulado | **9/9** |
| E2E `security-direct` | E2E real na borda publicada | **1 aprovado** (SR-1), 6 falhas de setup, 51 ignorados |
| `vite build` | build | **exit 0** |
| ESLint (7 arquivos alterados) | lint | **0 erro / 0 aviso** |
| `tsc -p jsconfig.json` | typecheck | **1815 erros preexistentes**, **0** nos arquivos desta rodada (módulos funcionais são `.ts` fora do `include` do typecheck) |
| `npm audit` | dependências | **não executado** — registry indisponível |

**Regressão preservada:** as suítes das Fases 1 e 2 e da 3.1 foram reexecutadas integralmente
após as correções, sem alteração de testes existentes e sem nenhuma falha.

## 12. Testes NÃO executados

| Não executado | Motivo | Consequência |
|---|---|---|
| E2E adversarial por perfil (manager, staff, participant, speaker, partner) | sem `tests/.auth/*.json` e sem credenciais de seed no ambiente; 6 arquivos falharam na **preparação** | RLS real e isolamento entre perfis **não comprovados** |
| Dois casos de Staff | mesma dependência | **permanecem pendentes** (nem aprovados nem reprovados) |
| Concorrência real (duas execuções simultâneas de campanha/estorno/emissão) | exige ambiente com carga concorrente | CAS e dedup comprovados **por código**, não por execução |
| `npm audit` | registry indisponível | dívida de dependências não medida |
| Testes de carga/reconnect | infraestrutura ausente | permanecem classificados como teste de infraestrutura |

## 13. Riscos residuais

1. RLS real por perfil não comprovada nesta rodada (apenas 1 chamada anônima E2E).
2. Concorrência real não exercitada; idempotência de campanha, estorno e pontuação é comprovada por
   construção (CAS + chave determinística), não por corrida de threads.
3. `deleteMyAccount` não foi executada de ponta a ponta — a correção é validada por inspeção e por
   testes dos construtores, não por exclusão real (proibida nesta auditoria).
4. Textos livres (`SessionQuestion.question`, `SessionReview.comment`, `ChatMessage`, `Feedback`)
   podem conter PII digitada pelo usuário e não são anonimizáveis automaticamente.
5. Sem rate limiting global: apenas `getTicketPdf` tem limite por usuário. Abuso de endpoints
   custosos (métricas, PDF, IA) permanece possível.
6. Tentativas de acesso negadas **não geram trilha** — a rastreabilidade de negativas existe apenas
   em log de aplicação, não em `AuditLog`.

## 14. Pendências de infraestrutura

- Estados de autenticação por perfil + contas de teste para a suíte E2E (bloqueia 3.1 e todo teste
  adversarial real).
- Ambiente de concorrência (duas invocações simultâneas controladas).
- Registry npm acessível para auditoria automatizada de dependências.
- Rate limiting por usuário/IP no nível da plataforma.

## 15. Decisões de negócio e validações jurídicas necessárias

| # | Item | Natureza | O que precisa ser decidido |
|---|---|---|---|
| D-01 | `Order.buyer_name/buyer_email` e `Ticket.holder_name/holder_email` **permanecem** após a exclusão de conta | **Jurídica** | Base legal e prazo de retenção para registro financeiro e controle de ingresso |
| D-02 | `AuditLog` cresce indefinidamente, sem política de retenção | **Jurídica + negócio** | Prazo de guarda da trilha (inclui dados pessoais em `details` — já anonimizados na exclusão) |
| D-03 | `executeRaffle` devolve e-mail dos sorteados ao operador | **Negócio** | Se o contato é necessário ou se basta nome parcial (minimização) |
| D-04 | `getEventTickets` permite listar lotes de evento em `draft`/`cancelled` | **Negócio** | Se a pré-visualização pela gestão deve continuar possível (hoje é) |
| D-05 | Textos livres com PII digitada | **Negócio + jurídica** | Se haverá revisão manual/anonymização por ocasião da exclusão |
| D-06 | Trilha de tentativas de acesso negadas | **Negócio** | Se vale o custo de gravar negativas (volume) |

## 16. Confirmação sobre deploy e produção

- **Nenhum deploy, publicação ou push** foi realizado.
- **Nenhuma migração** (`migrateEventFinance`) foi executada, nem em dry-run; os campos financeiros
  legados e as decisões anteriores sobre a migração foram preservados.
- **Nenhuma escrita em dados de produção** foi feita: não houve criação, alteração ou exclusão de
  registros; todos os testes usam dados sintéticos em memória.
- **Nenhum e-mail, notificação, pagamento ou estorno real** foi disparado.
- **Nenhum secret, credencial ou integração** foi alterado.
- **Nenhuma entidade, regra RLS ou workflow** foi modificado.
- O único tráfego real foi o teste SR-1 (chamada anônima **bloqueada**) contra a borda publicada.

---

## Tabela consolidada (obrigatória)

| ID | Etapa | Prioridade | Problema | Impacto | Correção | Evidência/Teste | Status |
|---|---|---|---|---|---|---|---|
| F3-01 | 3.1 | P2 | Referência cruzada entre eventos em `Session` (`track_id`/`room_id`/`speaker_id`) | Agenda inconsistente; vazamento de nome de palestrante de outro evento | `validateSessionReferences` em create/update de Session | `authz` 1–9 | **Corrigido e validado** (unitário) |
| F3-02 | 3.1 | P3 | `updateSessionMaterial` negava o dono quando havia múltiplos registros de palestrante | Falha fechada, sem exposição | Posse comparada ao `speaker_id` da sessão | `authz` + inspeção | **Corrigido, validação incompleta** (E2E pendente) |
| F3-03 | 3.1 | — | Acesso direto por SDK a Session/Track | — | Nenhuma (RLS admin-only + leitura proxiada) | Inspeção | **Não comprovado** (RLS real) |
| F3-04 | 3.1 | — | Mass assignment de `event_id`/`id` em `manageEventConfig` | — | Nenhuma (`sanitizeRecord` já remove) | Inspeção | **Verificado correto** |
| F3-05 | 3.1 | — | Reutilização de permissão após revogação | — | Nenhuma (filtros de `is_active`/`cancelled`) | `authz` 10–13 | **Verificado correto** |
| F3-06 | 3.1 | P1 | E2E por perfil e **2 casos de Staff** | Prova de comportamento real ausente | — | 6 falhas de setup; 1 E2E real aprovado (SR-1) | **Não testado** (ambiente) |
| F3-07 | 3.5 | P2 | Nome/e-mail de autoria sobreviviam à exclusão de conta (CFP, premiação, vagas) | Identificação de pessoa que pediu exclusão | Passo 9d em `deleteMyAccount` + `shared/anonymization.ts` | `fase3` 1–4 + inspeção | **Corrigido e validado** (unitário) |
| F3-08 | 3.4 | P2 | Participante podia gravar entradas na trilha de auditoria do evento | Trilha falsificável; investigação contaminada | `logAuditEvent` exige gestão do evento | `fase3` 6–9 (mecânica da trilha) + inspeção | **Corrigido, validação incompleta** (sem teste adversarial real) |
| F3-09 | 3.4 | P2 | Emissão de certificado sem trilha de auditoria | Sem prova de quem emitiu/quando/para quem | `writeMandatoryAudit` idempotente + `recordPendingTrail` em falha | `fase3` 5–9 + inspeção | **Corrigido, validação incompleta** |
| F3-10 | 3.3 | P3 | Comentário afirmava que o disparo agendado não revalida o emissor | Documentação de segurança enganosa | Comentário corrigido | Leitura cruzada `campaignDispatch` × `expireStaleReservations` | **Corrigido** (documental) |
| V-01 | 3.3 | — | Revalidação do emissor no disparo | — | Nenhuma | Inspeção (manual + agendado) | **Verificado correto** |
| V-02 | 3.3 | — | Audiência/escopo vindos do cliente | — | Nenhuma (campanha relida por id) | Inspeção | **Verificado correto** |
| V-03 | 3.3 | — | Claim concorrente de campanha | — | Nenhuma (CAS → `processing`) | Inspeção | **Verificado correto** |
| V-04 | 3.3 | — | Duplicidade/retomada de destinatários | — | Nenhuma (dedup + `sent` terminal) | Inspeção | **Verificado correto** |
| V-05 | 3.2 | — | Métricas globais de vendas/negócio | — | Nenhuma (admin-only) | Inspeção (falso positivo corrigido) | **Verificado correto** |
| V-06 | 3.2 | — | IDOR em pagamento/ingresso | — | Nenhuma (escopo por comprador/titular) | Inspeção | **Verificado correto** |
| V-07 | 3.2 | — | Trilha financeira acessível a não-admin | — | Nenhuma (admin-only) | Inspeção | **Verificado correto** |
| V-08 | 3.2 | — | Escalada de privilégio em `manageParticipant` | — | Nenhuma (gate + porta do gerente) | Inspeção | **Verificado correto** |
| V-09 | 3.2 | — | Concessão de curador/avaliador | — | Nenhuma (somente gerente) | Inspeção | **Verificado correto** |
| V-10 | 3.2 | — | Manipulação de sorteio | — | Nenhuma (pool server-side + CSPRNG) | Inspeção | **Verificado correto** |
| V-11 | 3.2 | — | Crédito indevido de pontos | — | Nenhuma (evidência + idempotência) | Inspeção | **Verificado correto** |
| V-12 | 3.2 | — | Conta excluída/inativa | — | Nenhuma (`requireActiveUser`) | Inspeção | **Verificado correto** |
| I-01 | 3.2 | P3 | Lotes de evento em `draft`/`cancelled` listáveis em `getEventTickets` | Exposição informativa mínima | Não alterado (decisão D-04) | Inspeção | **Identificado, não corrigido** |
| I-02 | 3.5 | P3 | `executeRaffle` devolve e-mail dos sorteados | Exposição de e-mail a operador que já gerencia o pool | Não alterado (decisão D-03) | Inspeção | **Identificado, não corrigido** |
| I-03 | 3.5 | P2 | `Order`/`Ticket` mantêm nome e e-mail após exclusão | Retenção de PII sem prazo documentado | Não alterado (decisão D-01) | Inspeção | **Identificado, não corrigido** |
| I-04 | 3.5 | P2 | Texto livre pode conter PII digitada | Reidentificação por conteúdo | Não alterado (decisão D-05) | Inspeção | **Identificado, não corrigido** |
| I-05 | 3.2 | P2 | Ausência de rate limiting global (exceto PDF) | Abuso de endpoints custosos | Não alterado (infra) | Inspeção | **Identificado, não corrigido** |
| I-06 | 3.4 | P2 | Acessos negados não geram trilha | Investigação de tentativas limitada | Não alterado (decisão D-06) | Inspeção | **Identificado, não corrigido** |
| I-07 | 3.4 | P3 | `AuditLog` sem política de retenção | Crescimento e retenção indefinida | Não alterado (decisão D-02) | Inspeção | **Identificado, não corrigido** |
| I-08 | 3.2 | P1 | RLS real por perfil não comprovado na base | Confiança limitada no isolamento entre perfis | — | E2E bloqueado por ambiente | **Não comprovado** |
| I-09 | 3.2 | P2 | Concorrência real não exercitada | Corridas não observadas em execução | — | Sem ambiente de concorrência | **Não testado** |
| I-10 | 3.2 | P2 | `npm audit` indisponível | Vulnerabilidades de dependência não medidas | — | Registry indisponível | **Não testado** |

---

## Resumo dos status

- **Corrigido e validado (unitário):** F3-01, F3-07.
- **Corrigido, validação incompleta:** F3-02, F3-08, F3-09 (e F3-10, documental).
- **Verificado correto por inspeção:** F3-04, F3-05, V-01 … V-12.
- **Identificado, não corrigido:** I-01 … I-07 (decisão de negócio/jurídica ou infraestrutura).
- **Não comprovado / não testado:** F3-03, F3-06, I-08, I-09, I-10.

**Conclusão de etapa:** 3.1, 3.2, 3.3, 3.4 e 3.5 estão **parcialmente validadas**. Nenhuma pode ser
declarada concluída enquanto a homologação adversarial por perfil (RLS real) e a concorrência real
não forem executadas. Aguardando revisão independente antes de qualquer deploy ou publicação.
