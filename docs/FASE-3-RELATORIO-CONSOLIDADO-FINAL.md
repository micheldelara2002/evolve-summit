# Evolve Summit — Relatório Consolidado Final da Fase 3

**Data:** 2026-11-16 (America/Sao_Paulo)
**HEAD inicial desta rodada:** `5e1235e` (rodada F3-14 — correção da revisão independente)
**HEAD final:** commit gerado pela plataforma ao salvar esta rodada (o ambiente do builder não executa escrita em git)
**Escopo:** fechamento das lacunas comprovadas da Fase 3 (segurança, integridade, auditoria, privacidade, performance) e consolidação documental.

**Ambiente:** nenhum deploy, nenhuma publicação, nenhuma migração, nenhuma escrita em produção, nenhum e-mail/campanha/pagamento/estorno real, nenhuma conta de usuário criada ou alterada, nenhuma configuração de autenticação ou RLS alterada. Todo teste roda com banco simulado em memória.

---

## A. Resumo executivo

**O que foi executado nesta rodada**

1. **Recuperação da trilha de alteração de papel (P1 fechado).** A falha total (trilha principal + pendência) deixava a alteração de papel permanentemente sem auditoria: na repetição, `changesRole` era falso e nada era tentado. Foi criada a operação `recoverRoleAudit`, que reconstrói a trilha a partir do **estado persistido**, com chave determinística pela ocorrência (`updated_date`), idempotente, sem aceitar autor/evento/papéis do cliente, e distinguindo os quatro desfechos: trilha confirmada, pendência persistida, trilha irreparável (503) e alteração não efetivada.
2. **Inventário e cobertura de todos os caminhos de papel (P1 fechado).** Concessões e revogações fora do `manageParticipant` (convite/vínculo de equipe, gerente, curador, avaliador), aceite de convite, promoção a palestrante pela curadoria, rebaixamento a *attendee*, e `partner_rep` na associação de parceiro passaram a gerar trilha pelo novo módulo `base44/shared/accessAudit.ts` — sem bloquear convite, aprovação de pauta ou vínculo de parceiro legítimos.
3. **CSV/Formula Injection (P2 fechado).** O helper passou a considerar `=`, `+`, `-`, `@`, TAB, CR, LF, espaços e caracteres de controle antes do conteúdo perigoso, preservando números negativos legítimos e mantendo o escaping de aspas/quebras/separador. As **duas** exportações do app (Pessoas e Vendas) usam o mesmo helper; nenhuma exportação constrói CSV manualmente.
4. **Dependências (P2 triado).** 27 vulnerabilidades (14 high, 13 moderate), com pacote, faixa vulnerável e classificação. Plano priorizado documentado; atualização não aplicada (instalação de pacotes neste ambiente é mediada pela plataforma e o `fix` exige validação de compatibilidade).
5. **Consolidação documental.** Este relatório substitui os documentos anteriores da Fase 3.

**Riscos eliminados nesta rodada:** alteração de privilégio sem trilha recuperável; concessões/revogações de acesso sem registro; injeção de fórmula nas exportações.

**Riscos residuais:** dependências vulneráveis (sem caminho explorável demonstrado), ausência de rate limiting de aplicação, ausência de retenção de `AuditLog`, e — o principal — **validação dinâmica não executada** (E2E autenticado, RLS real, concorrência em banco real, carga).

**Decisão de encerramento:** **Fase 3 não encerrada** — encerra-se com limitações documentadas apenas no código (ver J). Faltam evidências obrigatórias de ambiente real.

---

## B. Inventário de achados

| ID | Etapa | Prioridade | Problema | Impacto | Correção | Evidência | Status |
|---|---|---|---|---|---|---|---|
| P1-01 | 3.8 | P1 | `role_change` era best-effort: falha de `AuditLog` não impedia declarar a alteração concluída | Alteração de privilégio sem rastreabilidade | `writeMandatoryAudit` + `recordPendingTrailVerified` + 503 quando nada persiste | `certhttp` HTTP-20…HTTP-26; `fase3` (audit-logger 9) | **Corrigido e validado (simulado)** |
| P1-02 | 3.8 | P1 | Reemissão de certificado não recuperava trilha ausente | Certificado emitido impossível de auditar | `buildCertificateAuditEntry` reaplicado no caminho de certificado existente + `audit_recovered` | HTTP-1…HTTP-7, HTTP-10; `certificate-audit` 8 | **Corrigido e validado (simulado)** |
| P1-03 | 3.8 | P1 | Concessão/revogação de acesso fora do `manageParticipant` sem trilha (equipe, gerente, curador, avaliador, palestrante, `partner_rep`, aceite de convite) | Acesso concedido sem registro de quem, quando e a quem | `accessAudit.recordAccessChange` cabeado em `eventInvites`, `manageSubmission`, `associateEventPartner`, `manageEventRole` | `access` ACCESS-1…ACCESS-7 | **Corrigido e validado (unitário)** |
| P1-04 | 3.8 | P1 | Recuperação da trilha de papel inexistente após falha total | Alteração efetivada e permanentemente não auditada | Op `recoverRoleAudit`, agora ancorada em evidência durável (ver P1-05) | HTTP-27…HTTP-37 | **Corrigido e validado (simulado)** |
| P1-05 | 3.8 | P1 | `recoverRoleAudit` reconstruía a trilha a partir do **estado atual** (`role_in_event` + `updated_date`) | Criava `role_change` fictício para quem nunca teve papel alterado e atribuía a autoria ao operador da recuperação | Entidade `AccessChangeEvidence` gravada **antes** da mutação (evento, entidade, ocorrência, papel anterior/novo, ator original); a recuperação exige evidência, confere a correspondência com o estado e usa a autoria original (ou `system`, quando desconhecida); sem evidência a alteração não é aplicada (fail-closed) | HTTP-27…HTTP-37 | **Corrigido e validado (simulado)** |
| P1-06 | 3.8 | P1 | `setReviewer` com `membershipId` reativava `EventMembership` (`is_deleted:false`, `is_active:true`) **sem** passar pela auditoria central de acesso | Acesso de avaliador reconcedido sem trilha | Reativação via `recordAccessChange` com chave `reviewer_reactivation\|evento:vínculo:versão`, escopo e papel conferidos no servidor, titular derivado do vínculo, estado contraditório recusado, `audit_state` exposto e recuperação por retry | SR-1…SR-6 | **Corrigido e validado (simulado)** |
| P2-01 | 3.6 | P2 | CSV/Formula Injection nas exportações | Execução de fórmula na máquina do organizador | `csvCell` neutro p/ `= + - @`, TAB/CR/LF/controle, preserva negativo numérico | `csv` CSV-1…CSV-12 | **Corrigido e validado (unitário)** |
| P2-02 | 3.6 | P2 | 27 dependências vulneráveis (14 high) | DoS por payload, sanitização, credenciais em redirect | Triagem + plano; atualização não aplicada | `npm audit --omit=dev` | **Identificado — decisão pendente** |
| P2-03 | 3.6 | P2 | Sem rate limiting de aplicação | Abuso volumétrico/custo | Dependência de infraestrutura; documentado | inspeção | **Identificado — limitação de infraestrutura** |
| P2-04 | LGPD | P2 | `AuditLog` sem política de retenção | Custo + retenção além do necessário | Recomendação (D-02) | inspeção | **Identificado — decisão jurídica** |
| P2-05 | 3.8 | P2 | Gravação de acesso não bloqueia o fluxo (desenho deliberado) | Trilha pode ficar `unavailable` e o fluxo seguir | `audit_state` exposto nas respostas; pendência reconciliável | ACCESS-3, ACCESS-4 | **Risco aceito e documentado** |
| P3-01 | — | P3 | Typecheck com 1.814 erros preexistentes (sem tipos JSX) | Ruído de qualidade | Não corrigido (fora de escopo) | `npm run typecheck` | **Preexistente** |
| P3-02 | 3.1 | P3 | E2E autenticado por perfil bloqueado | Fluxos reais sem prova | — | ausência de identidades sintéticas | **Bloqueado (infraestrutura)** |
| P3-03 | 3.7 | P3 | Carga não executada | Escalabilidade não comprovada | — | — | **Não executado** |
| P3-04 | legado | P3 | `AwardCategory`/`AwardNomination` sem consumidores | Dado legado exposto | Mantidos (exclusão exige autorização) | grep em `src/` e `base44/` | **Documentado — decisão de negócio** |

---

## C. Evidências de testes

**Contagem de testes únicos: 249** (soma de declarações `test(` por arquivo, sem duplicar arquivos reutilizados por scripts). A soma por script é **258**, porque `test:unit:auditlog` reexecuta os 9 testes já incluídos em `test:unit:fase3`.

| Comando | Testes | Resultado |
|---|---|---|
| `npm run test:unit:refund` (7 arquivos) | 115 | ✅ 0 falhas |
| `npm run test:unit:security` | 9 | ✅ |
| `npm run test:unit:migration` | 25 | ✅ |
| `npm run test:unit:authz` | 13 | ✅ |
| `npm run test:unit:fase3` (privacidade 9 + logger 9 + certificado 8 + exclusão 9) | 35 | ✅ |
| `npm run test:unit:auditlog` | 9 | ✅ (reexecução — não somada) |
| `npm run test:unit:certhttp` | 33 | ✅ |
| `npm run test:unit:csv` | 12 | ✅ |
| `npm run test:unit:access` | 7 | ✅ |
| **Únicos** | **249** | **0 falhas** |

**Build:** `npm run build` → exit 0 (apenas aviso de `caniuse-lite` desatualizado).
**ESLint:** nos 12 arquivos tocados/criados → 0 erros, 0 avisos.
**Typecheck:** `npm run typecheck` → 1.814 erros preexistentes (projeto sem tipos JSX); nenhum introduzido nesta rodada (módulos novos não aparecem no relatório).
**`npm audit --omit=dev`:** 27 vulnerabilidades — 14 high, 13 moderate, 0 critical.
**E2E / RLS real / concorrência de banco / carga:** **não executados** (P3-02, P3-03). Nenhum resultado foi inferido de mock e apresentado como teste real.

**Ambiente dos testes:** Node + banco falso em memória; `npm:@base44/sdk` substituído por cliente injetado (`tests/unit/lib/base44-sdk-stub.mjs`). Sem rede, sem produção.

---

## D. Segurança (etapa 3.6)

### D.0 Inventário de caminhos de alteração de acesso

| Caminho | Função | Ator autorizado | Entidade | Trilha | Chave | Falha de trilha |
|---|---|---|---|---|---|---|
| Alteração de papel de participante | `manageParticipant` (`update`) | admin / manager / team (gate) | Participant | obrigatória | `role_change\|participant:<id>:<updated_date>` | 503 + caminho de recuperação |
| Recuperação de trilha de papel | `manageParticipant` (`recoverRoleAudit`) | admin / manager / team | Participant | obrigatória (reconstruída) | idem (determinística) | 503, `recovered:false` |
| Atribuição de equipe | `manageParticipant.assignStaff` | manager (não team) | EventMembership | obrigatória | `role_change\|membership:<id>` / `invite:<evento>:<email>` | 503 |
| Remoção de equipe | `manageParticipant.removeStaff` | manager | EventMembership / Participant | obrigatória | `role_change\|removal:<evento>:<email>` | 503 |
| Remoção de participante (soft delete) | `manageParticipant.softDelete` | manager/team | Participant | não é alteração de autorização (remoção de presença) | — | — |
| Concessão de papel por convite/vínculo | `eventInvites.grantEventRole` | quem chama (já autorizado) | EventMembership / EventInvite | `accessAudit` | `role_grant\|<membership ou invite>` | `audit_state` (não bloqueia) |
| Revogação de papel | `eventInvites.revokeEventRole` | manager/admin (callers) | EventMembership / EventInvite | `accessAudit` | `role_revoke\|<id>` | `audit_state` |
| Aceite de convite pendente | `eventInvites.linkPendingInvites` | sistema (1º acesso autenticado) | EventInvite | `accessAudit` | `invite_accepted\|<invite>` | `audit_state` |
| Curador/avaliador (conceder/revogar) | `manageEventRole`, `manageParticipant.setReviewer` | manager/admin | EventMembership | via `eventInvites` | idem | `audit_state` |
| **Reativação de avaliador** (F3-14) | `manageParticipant.setReviewer` (com `membership_id`) | manager/admin | EventMembership | `recordAccessChange` (`reviewer_reactivation`) | `reviewer_reactivation\|evento:vínculo:updated_date` | 503 + `audit_state: unavailable` + retry idempotente |
| Promoção a palestrante | `manageSubmission` (`approve`) | curadoria/gestão do evento | Participant | `accessAudit` | `role_change\|participant:<id>:<ocorrência>` | `audit_state` (não derruba aprovação) |
| Rebaixamento a *attendee* | `manageSubmission` (`cancel`) | curadoria/gestão | Participant | `accessAudit` | idem | `audit_state` |
| `partner_rep` por associação de parceiro | `associateEventPartner` | manager/admin do evento | Participant | `accessAudit` | `role_change\|participant:<id>:<ocorrência>` | `audit_state` |
| Inclusão de participante (compra/importação) | `commerceFulfillment`, `manageParticipant.bulkCreate` | sistema/gestão | Participant | não é concessão de acesso (inscrição) | — | — |

**Justificativa do desenho:** as operações que *decidem autorização administrativa* (papel de participante, equipe) bloqueiam com 503 quando não conseguem auditar. As que são *fluxos de negócio legítimos* (convite, aprovação de pauta, vínculo de parceiro) registram trilha confirmada ou pendência verificada e informam `audit_state`, sem derrubar o fluxo — bloquear convite ou aprovação por falha de log criaria um defeito pior, sem ganho de segurança.

### D.1 Autenticação e autorização

- **IDOR/BOLA, escalada horizontal/vertical, cross-event:** autorização por recurso derivada do banco em todos os módulos revisados (participante, certificado, submissão, sessão, parceiro, cupom, pedido). Testes: HTTP-AUTH, HTTP-26, HTTP-32, `authz` (13), `fase3`.
- **Mass assignment:** `manageParticipant` aceita apenas `WRITABLE_FIELDS`; autor, evento e papéis de gestão não vêm do cliente; HTTP-25 e HTTP-30 comprovam que o corpo não falsifica autor, evento nem papel recuperado.
- **Contas excluídas/sem vínculo:** `requireActiveUser` em 86 das 90 funções; as 4 restantes justificadas (assinatura Stripe, token M2M, `auth.me`, validação pública de certificado).
- **RLS:** 63 de 64 entidades com regra explícita; `User.jsonc` é entidade de plataforma. Leitura real de RLS não executada (P3-02).
- **Risco residual:** validação de RLS só estática.

### D.2 Injeções e execução indevida

- **NoSQL/JSON:** filtros montados por API tipada; nenhuma concatenação de operador vinda do cliente; `JSON.parse` protegido em todos os pontos revisados (`custom_answers`, `reviews`, `scores`, `assigned_reviewer_ids`).
- **XSS:** nenhum `dangerouslySetInnerHTML` com dado de usuário (único uso é o componente de gráfico do shadcn com CSS estático). `react-markdown` sem HTML bruto habilitado.
- **Command injection:** não há `exec`/`spawn` no backend.
- **Template injection:** nenhuma engine de template avaliando entrada do usuário (e-mails usam `{{variáveis}}` resolvidas pelo dispatcher).
- **CSV/formula injection:** **corrigido e testado** (CSV-1…CSV-12).
- **Validação de payload:** limites de tamanho por campo nos fluxos de escrita (título/resumo/nota truncados), lotes limitados a 200 registros no `bulkCreate`.

### D.3 SSRF, phishing e navegação externa

- **SSRF (`safeImageFetch`):** HTTPS obrigatório; bloqueio de localhost/`.local`/`.internal`/metadata e IP literal privado (v4/v6); verificação DNS A+AAAA fail-closed; **sem redirects**; timeout 6 s; teto de 2 MB em streaming; MIME + assinatura mágica (SVG/HTML recusados). Sem achado.
- **Open redirect:** não há redirect por parâmetro; retornos do Stripe usam o header de origem da plataforma.
- **`javascript:`/`data:`:** links renderizados como `href` só a partir de configuração interna.
- **Uploads:** avatar/logo passam por validação de tipo e tamanho; nenhum upload executável servido.
- **Risco residual:** validação dinâmica de SSRF/DNS rebinding não executada (exige ambiente controlado).

### D.4 Segredos, dependências e código malicioso

- **Segredos:** nenhuma chave literal em `src/` ou `base44/`; todas via `Deno.env`/secrets da plataforma; nada sensível retornado ao cliente.
- **Backdoors/endpoints ocultos:** nenhum encontrado. Não há código ofuscado, `eval`, `new Function`, nem chamada externa inesperada além de Stripe e resolução de imagens já mapeadas.
- **Dependências (detalhe):**

| Pacote | Faixa vulnerável | Uso | Exposição prática |
|---|---|---|---|
| `zod` | `<4.6.6` | validação de formulários (cliente) | DoS só com coleções gigantes; formulários são bounded |
| `dompurify` | `<=3.4.16` | sanitização em libs de PDF/HTML | caminho de conversão de PDF interno |
| `lodash` | `<=4.17.23` | utilitários | nenhum template compilado com entrada do usuário |
| `follow-redirects` | `1.16.0-1.16.1` | cliente HTTP transitivo | credencial em redirect não demonstrada |
| `js-yaml`, `brace-expansion`, `minimatch`, `picomatch`, `postcss`, `nanoid`, `ws`, `flatted`, `socket.io-parser`, `source-map-js` | várias | ferramental/transitivas | majoritariamente build/dev; sem caminho de entrada remota |

**Plano priorizado:** (1) `npm audit fix` sem `--force` para patch/minor não-breaking; (2) `zod@4` com revisão de schemas em rodada própria; (3) reauditar após cada etapa. **Não aplicado aqui:** atualização de lockfile é mediada pela plataforma e exige validação de compatibilidade com o SDK Base44.

### D.5 Abuso e disponibilidade

- **Rate limiting:** ausente na aplicação (P2-03). Certificados usam 96 bits de entropia — enumeração inviável; o risco é volumétrico/custo.
- **Payloads grandes:** limites por campo e por lote aplicados; `safeImageFetch` limita bytes.
- **Concorrência/idempotência:** CAS em estoque, presença (`presence_count`), lock de checkout, ledger de estorno e chaves de auditoria determinísticas — cobertos por 115 testes de refund e 23 HTTP.
- **Risco residual:** sem proteção de frequência própria.

---

## E. Performance (etapa 3.7)

**Caminhos revisados:** BusinessDashboard, campanhas de notificação, check-in/QR, pontuação/resgates, participantes, exportações, relatórios financeiros, certificados, sessões/trilhas.

| Item | Situação |
|---|---|
| `.list()` sem limite | `fetchAll` e paginação por cursor usados nos fluxos de volume; varreduras de manutenção limitadas (50–200) |
| Filtros no frontend | participantes e listagens de gestão filtram/paginam no servidor nas rotas críticas (`getEventParticipants`, `manageParticipant`) |
| N+1 | mitigado com `$in` fatiado (500/200) em pessoas, contas e documentos |
| Full scan | `findPersonsByDocument` foi reduzido ao escopo do evento (correção anterior); `MetricBucket` evita varredura de `created_date` |
| Ordenação | explícita (`-created_date`, cursor keyset) nos caminhos revisados |
| Índices | não gerenciáveis pelo app (plataforma); dependem de consulta por igualdade — já adotada em `created_day`/`bucket_date` |
| Agregações | contadores materializados (`MetricBucket`, `reconcileBusinessMetrics`) |
| Jobs | campanhas e reconciliações com orçamento de tempo, `has_more`, retomada e teto de tentativas |
| Frontend | lazy loading por rota, estados de carregamento; listas de volume usam paginação |
| Carga | **não executada** — sem dados sintéticos em volume nem ambiente isolado |

**Limite declarado:** p50/p95/p99, throughput e memória **não medidos**. Nenhuma afirmação de escalabilidade comprovada é feita neste relatório.

---

## F. Integridade e transações

| Operação | Mecanismo | Evidência |
|---|---|---|
| Estornos | ledger atômico, teto por `refund_committed_cents`, token de reserva, correlação por `refund_request_id`, idempotência Stripe | `refund` (115) |
| Estoque | `$inc` + `$addToSet` idempotente por ingresso, confirmação pós-CAS | `refund-stock-return` (8) |
| Resgates/pontos | débito atômico, contador de resgatados | `fase3` + serviços de pontos |
| Certificados | dedup determinística, trilha obrigatória, recuperação na reemissão | `certificate-audit` (8), HTTP-1…HTTP-10 |
| Sorteios/premiações | claim com token, ranking server-side | `fase3`, `award` |
| Notificações | emissor derivado do servidor, aprovação de conteúdo por hash, retomada | `fase3`, `campaign*` |
| Check-in/capacidade | claim atômico de vaga (`presence_count` CAS), bloqueio de ingresso em estorno | `refund`, `authz` — **sem teste de rajada real** |
| Papéis | trilha obrigatória + recuperação idempotente | HTTP-20…HTTP-33, `access` (7) |
| Migração de finanças | cursor keyset + trilha bloqueante | `migration` (25) |

**Nenhum hardening anterior foi reimplementado**; as correções desta rodada são aditivas.

---

## G. LGPD e privacidade

**Inventário:** nome, e-mail, telefone, CPF/documentos, dados de inscrição, dados financeiros (pedido/pagamento/estorno), mensagens, anexos/fotos, dados de autoria (submissões, cases, vagas) e logs de auditoria.

- **Minimização:** CPF e telefone removidos de listagens para não-gestão; PII de participantes só via função autorizada; `EventFinance` isolou dados financeiros do `Event`.
- **Acesso:** RLS admin-only nas entidades sensíveis; leitura do próprio dado pelo titular preservada.
- **Exposição entre eventos:** resolvida em participantes, documentos e parceiros (escopo por evento).
- **Exclusão/anonimização:** exclusão de conta anonimiza PII com marcadores imutáveis, preserva histórico e registra a operação; autoria de conteúdo é substituída (`account-deletion` 9).
- **Trilha:** operações críticas registradas com chave idempotente; acessos concedidos/revogados agora também.
- **Exportação:** CSVs neutralizados; download restrito à gestão.
- **Retenção:** **sem política definida** (D-01/D-02). Nenhum prazo legal foi inventado.
- **Backups/derivados:** contadores derivados são reconstruíveis; retenção de backup é da plataforma — fora do controle do app.

**Decisões pendentes:** D-01 retenção de pedidos/ingressos; D-02 retenção de `AuditLog`; D-03 e-mail de sorteados; D-04 leitura de ingresso em `draft`/`cancelled`; D-05 PII em campos livres; D-06 registro de acesso negado.

---

## H. Pendências

**Bloqueadores técnicos de validação (não impedem o código de estar correto):**
1. E2E autenticado por perfil (admin, manager, team, staff, speaker, participant, reviewer, partner) — sem identidades sintéticas; os dois casos de Staff seguem sem execução.
2. RLS adversarial contra API real.
3. Concorrência real de banco (última vaga, check-in duplicado, estorno simultâneo).
4. Carga (1.000 / 10.000 participantes, campanhas grandes, rajadas de check-in).

**Infraestrutura:** rate limiting de aplicação; ausência de ambiente isolado para carga; impossibilidade de atualizar lockfile sem mediação da plataforma.

**Jurídicas:** retenção de `AuditLog` (D-02); base legal para registro de acesso negado (D-06).

**De negócio:** retenção de pedidos (D-01); exposição de e-mail de sorteado (D-03); leitura de ingresso `draft` (D-04); PII em texto livre (D-05); decisão sobre `AwardCategory`/`AwardNomination` (sem consumidores no código; mantidos intactos).

**Melhorias não bloqueantes:** outbox dedicado para auditoria de acesso; upgrade de dependências; eliminação dos 1.814 erros de typecheck; avisos de lint preexistentes em `CsvImport.jsx`.

---

## I. Histórico

- **HEAD inicial:** `dd68ae5`
- **HEAD final:** commit da plataforma ao salvar esta rodada.
- **Working tree:** limpo após o save; nenhum arquivo removido; nenhuma alteração de entidade, RLS, workflow ou configuração.

**Arquivos alterados nesta rodada**

| Arquivo | Alteração |
|---|---|
| `base44/shared/accessAudit.ts` | **novo** — trilha de concessão/revogação de acesso (`recorded`/`pending`/`unavailable`) |
| `base44/functions/manageParticipant/entry.ts` | op `recoverRoleAudit`; dica de recuperação na resposta 503; ator na revogação de avaliador |
| `base44/shared/eventInvites.ts` | trilha em concessão (vínculo e convite), revogação (vínculo e convite) e aceite de convite; `auditState` no resultado |
| `base44/functions/manageSubmission/entry.ts` | trilha de promoção a palestrante e de rebaixamento a *attendee*; `audit_state` nas respostas |
| `base44/functions/associateEventPartner/entry.ts` | trilha de `partner_rep` (criação e alteração); `audit_states` na resposta |
| `base44/functions/manageEventRole/entry.ts` | ator na revogação + `audit_state` na resposta |
| `src/lib/csvSafe.js` | prefixos ampliados (`= + - @`, TAB/CR/LF/controle/espaços), negativo numérico preservado, `csvRow` |
| `tests/unit/fase3-http-audit.test.mjs` | HTTP-27…HTTP-33 (recuperação, idempotência, concorrência, cross-event, corpo não autoritativo) |
| `tests/unit/csv-injection.test.mjs` | CSV-6…CSV-12 (tab/CR/LF, controle, delimitadores, linha completa) |
| `tests/unit/access-audit.test.mjs` | **novo** — ACCESS-1…ACCESS-7 |
| `package.json` | script `test:unit:access` |

---

## J. Decisão final por etapa

| Etapa | Classificação | Justificativa |
|---|---|---|
| **3.6 — Segurança contra ataques** | **Parcialmente validada** | Vetores analisados com evidência estática; CSV corrigido e testado; SSRF e segredos sem achado. Rate limiting e exploração dinâmica não comprovados. |
| **3.7 — Performance** | **Não concluída** | Somente inspeção; nenhuma métrica de carga medida. |
| **3.8 — Integridade e auditoria** | **Concluída com limitações documentadas** (revisão F3-14 aplicada) | Trilha de papel provada por evidência gravada antes da mutação (P1-05) e reativação de avaliador auditada (P1-06); validação em banco real e revisão independente ainda pendentes. |
| **3.1 — E2E por perfil / RLS real** | **Parcialmente validada** | Estática (RLS e guardas) concluída; E2E e RLS real bloqueados. |
| **Dependências** | **Concluída com limitações documentadas** (triagem) | Inventário e plano prontos; atualização não aplicada. |
| **LGPD** | **Concluída com limitações documentadas** (inventário) | Controles mapeados; retenção depende de decisão. |
| **Legado Award** | **Concluída** (situação documentada) | Sem consumidores no código; nada removido. |

### Critérios de encerramento (§12)

| # | Critério | Situação |
|---|---|---|
| 1 | Recuperação da auditoria de papéis corrigida e testada | ✅ |
| 2 | Caminhos de papel inventariados e protegidos | ✅ |
| 3 | Proteção CSV completa e testada | ✅ |
| 4 | 3.6 com relatório, evidências e riscos residuais | ✅ (com limitação de rate limiting) |
| 5 | 3.7 com evidências e limites | ⚠️ sem métricas de carga |
| 6 | Award documentado | ✅ |
| 7 | Capacidade/check-in executados ou limitação registrada | ⚠️ limitação registrada, não executado |
| 8 | E2E por perfil executados ou bloqueados formalmente | ⚠️ bloqueio registrado |
| 9 | Dependências triadas com plano | ✅ |
| 10 | Suítes, build e lint verdes sem regressão | ✅ (239 testes, 0 falhas) |
| 11 | Relatório consolidado refletindo o repositório | ✅ |
| 12 | Sem P0/P1 conhecido sem tratamento | ✅ |

**Conclusão:** **Fase 3 não encerrada.** Os critérios 5, 7 e 8 dependem de ambiente de homologação com identidades sintéticas, dados em volume e banco real — não de correção de código. Encerrar agora equivaleria a declarar aprovado o que foi apenas inspecionado. O código está pronto para a rodada de homologação.

**Sobre P1 = 0 (revisão independente):** os dois P1 apontados na revisão de 2026-11-16 estão corrigidos e cobertos por testes de caminho HTTP (ver seção K). Isso **não** autoriza declarar P1 = 0 por si só: a evidência de auditoria agora comprova a operação original, mas a cobertura de todos os caminhos de reativação de reviewer e a validação em banco real seguem dependendo da revisão independente e da homologação. A Fase 3 permanece **aguardando revisão independente**.

---

## K. Correção final F3-14 — trilha de auditoria de papéis (2026-11-16)

### K.1 Causa raiz

**P1-05 — recuperação sem evidência.** A op `recoverRoleAudit` (F3-13) derivava a trilha do **estado atual** do `Participant`: usava `role_in_event` como "papel novo" e `updated_date` como "ocorrência". Duas consequências:

1. `role_in_event` não é prova de trânsito — qualquer participante tem um papel. Um registro `role_change` podia ser criado para alguém que nunca teve papel alterado (basta chamar a op com o id).
2. A autoria vinha do **usuário autenticado no momento da recuperação**, não de quem alterou. Quem recupera assumia a autoria de uma operação que não executou.

O defeito era de **modelo de evidência**, não de código defensivo: faltava registrar, no momento da mutação, o que a trilha precisaria provar depois.

**P1-06 — reativação de avaliador fora da auditoria central.** O ramo de `setReviewer` que recebe `membershipId` reativava o vínculo com `EventMembership.update({ is_deleted:false, is_active:true, user_id, user_email })` e retornava sucesso — sem passar por `recordAccessChange`, ao contrário da concessão e da revogação, que já auditavam. Havia ainda dois efeitos colaterais no mesmo ramo: o **titular vinha do corpo** (`body.user_id`) e o vínculo era buscado sem conferir evento/papel no servidor (o filtro incluía `event_id`/`role`, mas a atualização em si não revalidava nada).

### K.2 Solução aplicada

**Evidência durável (nova entidade `AccessChangeEvidence`, RLS admin-only).** Antes de mutar, o backend grava evento, tipo e id da entidade, operação, ocorrência (gerada no servidor), papel anterior, papel novo, **ator original** (do contexto autenticado) e a chave da trilha. Se a evidência não puder ser gravada, a alteração **não acontece** (503, `applied: false`) — fail-closed: privilégio não muda sem possibilidade de trilha. Depois da mutação a evidência passa a `applied` e, ao final, espelha o desfecho da trilha (`audit_recorded` / `audit_pending` / `audit_unavailable`).

**`recoverRoleAudit` reescrita.** Agora:

- exige evidência do evento + participante (sem evidência → 409, nenhuma trilha);
- confere que o papel persistido **corresponde** ao `new_value` da evidência (divergência → 409);
- recusa evidência em `started` (mutação não concluída);
- usa a **ocorrência e a chave da evidência** (retry e recuperações simultâneas convergem para um registro);
- usa a **autoria original**; se desconhecida, registra `user_id: 'system'` / "Autor original desconhecido", com `recovered_by_user_id` identificando quem recuperou;
- `evidence_id` serve apenas como seleção; se não pertencer ao participante, recusa;
- `audit_recorded` apenas confirma (idempotente), inclusive se o registro tiver desaparecido.

**`setReviewer` reativação auditada.** Escopo e papel conferidos no servidor (vínculo de outro evento → 404; estado contraditório `is_active && is_deleted` → 409); titular derivado do vínculo/e-mail, nunca do corpo; reativação via `recordAccessChange` com chave determinística `reviewer_reactivation|evento:vínculo:updated_date`; `already_active` devolve `audit_state` sem regravar; falha de auditoria → 503 com `audit_state: unavailable` e caminho de retry; retry recalcula a mesma chave e recupera a trilha. Concessão e revogação passaram a devolver `audit_state` (antes era descartado).

### K.3 Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `base44/entities/AccessChangeEvidence.jsonc` | **novo** — evidência durável da alteração de acesso (RLS admin-only) |
| `base44/functions/manageParticipant/entry.ts` | evidência antes da mutação (fail-closed); `recoverRoleAudit` reescrita sobre evidência; reativação de avaliador via `recordAccessChange`; `audit_state` em concessão/revogação |
| `tests/unit/fase3-http-audit.test.mjs` | HTTP-27…HTTP-37 (recuperação por evidência) e SR-1…SR-6 (reativação/concessão/revogação de avaliador) |

Nenhuma alteração de RLS existente, autenticação, dependências, AwardCategory/AwardNomination ou fluxos fora do escopo.

### K.4 Testes executados

**Testes novos (17 no arquivo HTTP, +10 no total único):**

| # | Cenário | Resultado |
|---|---|---|
| HTTP-27 | alteração real com trilha pendente → recuperação conclui com o ator original | ✅ |
| HTTP-28 | retry após recuperação → nenhuma duplicidade | ✅ |
| HTTP-29 | falha de persistência na recuperação → 503, evidência preservada, repetível | ✅ |
| HTTP-30 | corpo adulterado (ator/papéis) ignorado; evento diferente → 403 | ✅ |
| HTTP-31 | duas recuperações simultâneas → uma única trilha | ✅ |
| HTTP-32 | participante sem alteração → recuperação negada, nada criado | ✅ |
| HTTP-33 | estado persistido incompatível com a evidência → recusado | ✅ |
| HTTP-34 | autor original desconhecido → `system`, operador registrado como recuperador | ✅ |
| HTTP-35 | evidência de operação não aplicada (`started`) → recusado | ✅ |
| HTTP-36 | sem evidência durável → alteração não aplicada (fail-closed) | ✅ |
| HTTP-37 | evidência de outro participante → recusada, evidência legítima intacta | ✅ |
| SR-1 | reativação de vínculo existente → trilha obrigatória | ✅ |
| SR-2 | reativação repetida → sem duplicidade | ✅ |
| SR-3 | auditoria indisponível → 503 explícito; retry recupera sem duplicar | ✅ |
| SR-4 | vínculo de outro evento → 404, nada muda | ✅ |
| SR-5 | vínculo inexistente → 404; estado contraditório → 409 | ✅ |
| SR-6 | concessão e revogação → trilha consistente e `audit_state` exposto | ✅ |

**Regressão:** suíte completa — refund 115, security 9, migration 25, authz 13, fase3 35, certhttp 33, csv 12, access 7 → **249 testes únicos, 0 falhas**. Fluxos de concessão, revogação, convite, aceite de convite (HTTP/unitários de `eventInvites`), palestrante (`manageSubmission`) e `partner_rep` (`associateEventPartner`) sem regressão.

**Build:** exit 0 · **Lint:** 0 erros nos arquivos alterados · **Typecheck:** 1.814 erros preexistentes (nenhum novo).

### K.5 Limitações que permanecem

1. **Alterações anteriores à F3-14 não têm evidência** e, por decisão de projeto, **não são recuperáveis**: reconstruí-las exigiria voltar ao estado-como-prova, que é exatamente o defeito corrigido. A trilha dessas operações (se ausente) permanece ausente e documentada como tal.
2. **Validação em banco real, E2E autenticado por perfil, concorrência real e carga:** não executados (categorias P3-02/P3-03 da seção B, inalteradas).
3. **Evidência não é trilha**: ela comprova a operação e alimenta a recuperação; a trilha continua sendo o `AuditLog` com chave determinística. Reconciliação de pendências segue por `resolvePendingTrails`.
4. **Retenção de `AccessChangeEvidence`** não definida (mesma decisão jurídica de `AuditLog`, D-02).

### K.6 Classificação de risco revisada

| Item | Antes | Depois |
|---|---|---|
| Reconstrução de trilha sem prova de alteração | P1 | **Encerrado** (sem evidência → sem trilha; evidência obrigatória antes da mutação) |
| Atribuição indevida de autoria | P1 | **Encerrado** (autoria original da evidência; desconhecida → sistema) |
| Reativação de avaliador sem trilha | P1 | **Encerrado** (mecanismo central + chave idempotente + retry) |
| Concessão/revogação sem `audit_state` exposto | P3 | **Encerrado** |
| Alteração de privilégio sem evidência prévia | — | **Encerrado** (fail-closed, HTTP-36) |
| Trilha de operações anteriores à F3-14 sem evidência | — | **Risco aceito e documentado** (K.5.1) |
| Validação em ambiente real | P2 | **P2 — pendente** (homologação) |

**P1 = 0 é declarado apenas para os dois defeitos apontados na revisão**, e condicionado à revisão independente. A Fase 3 permanece aberta até essa revisão e até a homologação dos critérios 5, 7 e 8.

---

## L. Rodada de fechamento F3-15 — evidência, idempotência e titularidade (2026-11-17)

Fecha as três lacunas apontadas pela revisão independente do HEAD `8a00fe6`. Não houve nova
auditoria ampla nem refatoração de módulos fora dos caminhos de acesso.

### L.1 Causa raiz dos três problemas

**P1-a — Evidência presa em `started`.** A ordem era: (1) evidência `started`; (2) mutação do
`Participant`; (3) `markEvidence('applied')`; (4) `AuditLog`. `markEvidence` engolia a exceção.
Com a mutação efetivada e a atualização da evidência falhando, o papel mudava e a evidência
permanecia `started` — estado que `recoverRoleAudit` recusava. Resultado: papel alterado sem
caminho de trilha. A causa profunda era **não existir prova durável de que a escrita aconteceu**:
o estado do registro era lido como se fosse a própria prova.

**P1-b — Leitura do `AuditLog` não era fail-closed.** Em `recoverRoleAudit` a consulta da trilha
estava em `try/catch` com `catch` vazio e o fluxo seguia para a escrita. Timeout, erro de
permissão ou resposta inválida eram tratados como "registro não encontrado" — a operação que
promete idempotência podia duplicar a trilha. `findAuditByKey` (usado por `writeMandatoryAudit`)
também assumia lista: uma resposta em formato de página retornava "ausente".

**P1-c — Titularidade do reviewer vinha do corpo.** No ramo de reativação, `targetEmail` era
`membership.user_email || email`, e `email` podia ser `body.user_email`. Não havia confirmação de
que o `user_id` do vínculo pertencesse à `person_id` do vínculo, nem validação de `person_id`
divergente. O corpo podia substituir a identidade.

### L.2 Decisões de implementação

1. **Token de ocorrência como prova de mutação** (`Participant.last_role_change_occurrence`).
   O token é gerado no servidor e gravado **na mesma escrita** que altera `role_in_event`, seguido
   de confirmação por leitura. `reconcileRoleEvidence` passa a classificar a ocorrência:
   - token da própria ocorrência + papel == `new_value` → **mutação aplicada** (recuperável, inclusive `started`);
   - sem token → `nao_aplicada` (nada prova a escrita);
   - token de ocorrência **posterior** → `superada_por_ocorrencia_posterior`;
   - token da ocorrência com papel divergente → `estado_divergente`;
   - evidência já marcada como aplicada → exige papel correspondente.
   Uma segunda alteração legítima sobrescreve o token: a ocorrência anterior deixa de ser
   inferível e a recuperação é **recusada**, nunca recebendo `old/new` por suposição.
2. **Seleção da ocorrência pelo estado**, não por horário: com token, a evidência selecionada é a
   que o próprio registro aponta. `evidence_id` só seleciona — se não pertencer ao participante
   do evento, é recusado.
3. **Leitura tripartite da trilha** (`readAuditByKey` em `shared/auditTrail.ts`):
   `found` / `absent` / `unavailable`. `recoverRoleAudit` grava **somente** com `absent`
   confirmado; `unavailable` responde 503 sem qualquer escrita (nem pendência).
   `findAuditByKey` passou a rejeitar resposta não-lista, então `writeMandatoryAudit` também fica
   fail-closed (indisponibilidade, nunca ausência).
4. **Titularidade derivada só do servidor** (`resolveMembershipHolder`): `person_id` do vínculo →
   `Person` → conta confirmada. Com `user_id`, a conta precisa pertencer à pessoa (e-mail da conta
   igual ao `contact_email` da pessoa ou ao snapshot do vínculo). Sem `user_id`, a conta é
   resolvida pelo e-mail **persistido** da pessoa; sem identidade suficiente, a reativação é
   recusada (409) e exige novo fluxo de concessão/convite. `body.person_id` divergente → 409;
   `body.user_email` é ignorado. O `person_id` do corpo deixou de ser obrigatório **apenas** na
   reativação (a concessão continua exigindo pessoa).
5. **No-op continua sem trilha**: repetir o papel atual não gera evidência nem registro (HTTP-23).

### L.3 Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `base44/entities/Participant.jsonc` | campo `last_role_change_occurrence` (token de prova; aditivo, sem alteração de RLS) |
| `base44/functions/manageParticipant/entry.ts` | token na mesma escrita + confirmação por leitura; reconciliação de `started`; seleção por token; leitura fail-closed; `resolveMembershipHolder`; validação de `person_id` do corpo |
| `base44/shared/auditTrail.ts` | `readAuditByKey` (found/absent/unavailable); `findAuditByKey` rejeita resposta não-lista |
| `base44/shared/accessAudit.ts` | comentário de compatibilidade com a idempotência fail-closed (sem mudança de comportamento) |
| `tests/unit/fase3-http-audit.test.mjs` | banco falso com novas injeções de falha; HTTP-38..47 e SR-7..13; HTTP-33 e HTTP-35 reespecificados |
| `docs/FASE-3-RELATORIO-CONSOLIDADO-FINAL.md` | esta seção |

Caminhos revisados sem alteração de contrato: `manageEventRole`, `shared/eventInvites.ts`,
`manageSubmission`, `associateEventPartner` — todos já auditam por `recordAccessChange`/
`auditRoleChange` com chave determinística, pendência verificada e `audit_state` exposto; a
leitura prévia passou a ser fail-closed por `findAuditByKey`, sem mudança nos seus fluxos.

### L.4 Comportamento em cada cenário de falha

| Cenário | Comportamento |
|---|---|
| Evidência criada, mutação falha | 500 (erro da escrita), papel inalterado, evidência `started`, **nenhuma trilha**; recuperação recusa (`nao_aplicada`) |
| Mutação aplicada, atualização da evidência falha | token persistido; recuperação classifica `mutacao_aplicada_evidencia_nao_atualizada` e grava a trilha com o ator original |
| Evidência `started` sem mutação | 409 `nao_aplicada`; nada gravado |
| Evidência `started` com mutação comprovada | 200, trilha gravada com `old/new` da evidência |
| Segunda alteração legítima antes da recuperação | 409 `superada_por_ocorrencia_posterior` para a antiga; a nova é a vigente; nunca `old/new` inventados |
| Estado contraditório (token + papel divergente) | 409 `estado_divergente`; fail-closed |
| Evidência de outro evento/participante | 409; nenhuma trilha |
| Duas reconciliações simultâneas | uma única trilha (chave determinística + dedupe pós-leitura) |
| Retry após sucesso | `already_recorded`, nenhuma duplicidade |
| Autor original desconhecido | autoria `system` / "Autor original desconhecido"; recuperador registrado como tal |
| Leitura da trilha indisponível | 503 `unavailable`, **sem gravação e sem pendência**; retry usa a mesma chave |
| Resposta de leitura inconclusiva (página/objeto) | 503; nunca "não encontrado" |
| Falha principal + pendência ok | `pending` (pendência relida por leitura), evidência `audit_pending` |
| Falha principal + pendência falha | `unavailable` (503 quando aplicável); nada declarado auditado |
| Leitura ok com trilha existente | apenas confirma; nenhum registro adicional |
| Reativação legítima | 200, vínculo ativo com `user_id`/`user_email` da pessoa |
| Titularidade divergente / usuário de outra pessoa | 409 `identity_mismatch`; vínculo intocado; nenhuma trilha |
| Identidade incompleta (sem pessoa) | 409 `membership_without_person` |
| Sem conta confirmada | 409 `account_not_linked` |
| `person_id` do corpo divergente | 409 `person_id_mismatch` |
| E-mail do corpo diferente do persistido | ignorado; vale a identidade persistida |
| Vínculo de outro evento | 404 antes de qualquer efeito |
| Repetição de operação já ativa | `already_active`, mesma chave, sem duplicidade |

### L.5 Testes executados e resultados

Suítes (chaves npm): `test:unit:certhttp` **50** (33 anteriores + 17 novos), `test:unit:refund`
115, `test:unit:security` 9, `test:unit:migration` 25, `test:unit:authz` 13, `test:unit:fase3` 35,
`test:unit:csv` 12, `test:unit:access` 7 → **266 testes únicos, 0 falhas**.
A suíte financeira foi repetida porque `writeMandatoryAudit` é compartilhado por check-out,
estorno e certificados; a alteração em `findAuditByKey` toca essas garantias.

Novos cenários HTTP (funções reais + banco falso + injeção de falha):

| Teste | Cenário | ✅ |
|---|---|---|
| HTTP-38 | evidência criada, mutação falha → sem trilha, recuperação recusa | ✅ |
| HTTP-39 | mutação aplicada com evidência presa em `started` → reconciliação segura, ator original, retry idempotente | ✅ |
| HTTP-40 | `started` só recupera com o token da própria ocorrência | ✅ |
| HTTP-41 | segunda alteração legítima antes da recuperação → sem `old/new` por suposição | ✅ |
| HTTP-42 | evidência de outro evento → recusada | ✅ |
| HTTP-43 | duas reconciliações simultâneas de `started` → uma trilha | ✅ |
| HTTP-44 | leitura indisponível → 503 sem gravação; retry na mesma chave | ✅ |
| HTTP-45 | resposta inconclusiva → 503 (nunca ausência) | ✅ |
| HTTP-46 | falha principal + pendência → `pending`; retry grava uma única trilha | ✅ |
| HTTP-47 | leitura ok com trilha existente → apenas confirma | ✅ |
| SR-7 | vínculo sem `user_id` → conta resolvida pela Person persistida | ✅ |
| SR-8 | vínculo sem `user_email` → titularidade e snapshot regravados da Person | ✅ |
| SR-9 | `person_id` divergente → 409, nada muda | ✅ |
| SR-10 | `user_id` de outra pessoa → 409, vínculo intocado | ✅ |
| SR-11 | vínculo sem pessoa → 409 | ✅ |
| SR-12 | e-mail/ator do corpo ignorados | ✅ |
| SR-13 | pessoa sem conta → 409 | ✅ |

As asserções verificam estado final de `Participant`/`EventMembership`/`AccessChangeEvidence`,
a trilha persistida (`audit_key`, `action`, `entity_type`, `entity_id`, `event_id`, `user_id`),
o `old/new` gravado, a contagem de pendências e a **ausência** de registros indevidos.

HTTP-33 e HTTP-35 foram reespecificados: antes dependiam de inferência por horário e de recusa
incondicional de `started`; agora testam, respectivamente, estado contraditório por token e
ausência de prova de mutação.

### L.6 Evidências de idempotência

Chave determinística `role_change|<occurrence>` (ocorrência gerada no servidor) mantida em
todos os retries; recuperação simultânea testada (HTTP-43); retry após sucesso sem novo registro
(HTTP-39/47); pendência com chave própria `|pending` e recheck por leitura; nenhuma gravação sem
`absent` confirmado (HTTP-44/45).

### L.7 Evidências de titularidade e autoria

Titularidade derivada de `EventMembership.person_id → Person → conta` (SR-7/8), recusa em
divergência (SR-9/10) e em identidade insuficiente (SR-11/13); corpo ignorado (SR-12). Autoria
sempre do ator original da evidência, com `recovered_by_user_id` separado (HTTP-39 e HTTP-34).

### L.8 Limitações e riscos residuais

1. **Participantes com alteração de papel anterior à F3-15 não têm token**: ocorrências antigas
   em `started` continuam não recuperáveis por inferência — exigem conferência manual. Evidências
   `applied`/`audit_*` anteriores seguem o critério anterior (papel == `new_value`).
2. **Alterações de papel fora de `manageParticipant`** (ex.: reversão de palestrante na curadoria)
   não gravam o token; se ocorrerem entre a escrita e a reconciliação, a classificação é
   `superada`/`estado_divergente`, nunca trilha inventada.
3. **Ambiente real não exercitado nesta rodada**: E2E autenticado por perfil, concorrência em banco
   real e carga continuam em P2 (inalterado). Nada foi executado contra dados de produção.
4. **Retenção** de `AccessChangeEvidence` e `AuditLog` segue indefinida (decisão jurídica D-02).

### L.9 Classificação de risco revisada

| Item | Antes | Depois |
|---|---|---|
| Evidência presa em `started` sem caminho de recuperação | P1 | **Encerrado** (token na mesma escrita + reconciliação; HTTP-38/39/40) |
| Leitura do `AuditLog` tratada como ausência | P1 | **Encerrado** (`found`/`absent`/`unavailable`; HTTP-44/45) |
| Titularidade do reviewer derivada do corpo | P1 | **Encerrado** (`resolveMembershipHolder`; SR-7..13) |
| Inferência de `old/new` por horário | P1 | **Encerrado** (seleção por token + `superada`; HTTP-41) |
| Ocorrências anteriores à F3-15 sem token | — | **Risco aceito e documentado** (L.8.1) |
| Alterações de papel fora do módulo Pessoas sem token | — | **P3 — documentado** (L.8.2; falha fechada) |
| Validação em ambiente real / carga | P2 | **P2 — pendente** (homologação) |

**P1 = 0 nesta rodada significa**: nenhum dos três defeitos apontados permanece reproduzível nos
testes adversariais e no código revisado. Não há declaração de ausência geral de riscos; os itens
P2/P3 acima continuam abertos e a Fase 3 permanece condicionada à revisão independente e à
homologação em ambiente real.

---

## M. F3-16 — Porta de integridade do papel e vínculo reviewer ↔ conta ↔ Person (2026-11-18)

### M.1 Defeitos corrigidos

**P1-A — perda de evidência por sobrescrita do token.** A ocorrência A era aplicada e a trilha
falhava; B era aplicada antes da recuperação de A e sobrescrevia `last_role_change_occurrence`.
A recuperação de A devolvia `superada_por_ocorrencia_posterior` — correto para não inventar a
transição, mas A ficava efetivada e sem trilha **para sempre**, e nenhuma nova tentativa resolvia.

**P1-B — titularidade do reviewer provada por e-mail.** A conta era localizada e o titular
"provado" por igualdade de e-mail (`account.email == Person.contact_email` ou o snapshot do
vínculo). E-mail é dado mutável e reutilizável: com vínculos inconsistentes ou desatualizados a
coincidência não prova que a conta pertence à Pessoa, e um e-mail reaproveitado reativava acesso
de avaliador para a pessoa errada.

### M.2 Mudanças de código

- `Participant` — novos campos: `role_change_locked` (claim da alteração em andamento) e
  `role_audit_pending` (ocorrência aplicada cuja trilha ainda não foi confirmada por leitura).
  Nenhum dos dois é fonte de permissão nem aparece na UI.
- `manageParticipant`:
  - `roleChangeGate` roda **antes** de qualquer escrita: sem pendência → `clear`; pendência com
    trilha ausente → `blocked` (409); leitura indisponível → `unavailable` (503, fail-closed);
    pendência com trilha encontrada → libera o claim por CAS da própria ocorrência e segue.
  - claim + mutação do papel + token da ocorrência + pendência de auditoria na **mesma escrita
    condicional** (`updateMany` com `{ role_change_locked: { $ne: true } }`), confirmada por
    leitura — em concorrência exatamente um escritor casa o filtro.
  - perdedor da corrida: evidência encerrada em `not_applied` (nunca recuperável, nunca
    bloqueante) e resposta 409 `role_change_concurrent`.
  - liberação do claim apenas por CAS atrelado ao token pendente e confirmada por leitura;
    `pending` **não** libera (pendência registrada não é trilha gravada).
  - `resolveMembershipHolder`: a prova passou a ser `account.person_id === membership.person_id`.
    E-mail e `user_id` do corpo servem apenas para localizar a conta; sem vínculo confirmado a
    reativação é recusada (`account_person_link_missing`) e a regularização é reconceder o acesso
    pelo fluxo de convite; e-mail coincidente com `person_id` divergente é `identity_mismatch`.
- `AccessChangeEvidence` — novo estado `not_applied` para a tentativa que perdeu o claim.

### M.3 Evidências de teste

- `tests/unit/fase3-role-audit-integrity.test.mjs` (novo, HTTP ponta a ponta com banco falso):
  - **P1-A**: HTTP-48 (A sem auditoria bloqueia B), HTTP-49 (concorrência: um vencedor, um 409),
    HTTP-50 (retry não "sucede"), HTTP-51 (recuperação libera e B passa), HTTP-52 (consulta de
    evidência indisponível → fail-closed), HTTP-53 (trilha apenas pendente não libera; a porta se
    recupera quando a varredura grava a trilha), HTTP-54 (pendência não bloqueia outro
    participante), HTTP-55 (nenhuma ocorrência efetivada fica sem trilha ou pendência),
    HTTP-56 (falha de escrita não deixa mutação nem trilha).
  - **P1-B**: SR-14 (e-mail coincidente com vínculo de outra pessoa), SR-15 (snapshot divergente
    não invalida vínculo comprovado), SR-16 (corpo não é prova), SR-17 (conta sem vínculo),
    SR-18 (vínculo de outro evento), SR-19 (retry de reativação converge na mesma trilha).
- `tests/unit/fase3-http-audit.test.mjs`: fixture ganhou CAS (`updateMany`), injeção de falha de
  escrita do participante e de consulta de evidência; HTTP-38 e HTTP-41 foram reespecificados
  para a porta (mutação não comprovada → 503; ocorrência pendente bloqueia a seguinte).

### M.4 Resultados da rodada

| Verificação | Resultado |
|---|---|
| `test:unit:certhttp` (base + integridade) | 65/65 |
| `test:unit:fase3` | 35/35 |
| `test:unit:access` | 7/7 |
| `test:unit:authz` | 13/13 |
| `test:unit:migration` | 25/25 |
| `test:unit:security` | 9/9 |
| `test:unit:refund` | 115/115 |
| `test:unit:csv` | 12/12 |
| `vite build` | exit 0 |
| `lint` | 0 problemas (6 imports órfãos removidos) |
| `typecheck` | falha **pré-existente** em `src/pages/ValidaCertificado.jsx` (props não tipadas em `Button`), fora do escopo desta correção |

### M.5 Limitações e riscos residuais

1. **Sem transação entre documentos** na plataforma: a garantia é a atomicidade do CAS de um único
   documento somada à confirmação por leitura. Um crash entre a escrita do participante e a
   gravação da trilha deixa a ocorrência **pendente** e bloqueia novas alterações até a
   recuperação/varredura — falha fechada, nunca perda silenciosa.
2. **Desbloqueio operacional**: enquanto a trilha não aparecer, novas alterações de papel do mesmo
   participante são recusadas (`recoverRoleAudit` ou a varredura de manutenção, com a mesma chave
   determinística, liberam sozinhas).
3. **Contas legadas sem `person_id`** não podem ter o vínculo de avaliador reativado; exigem
   reconcessão pelo fluxo de convite (que grava User↔Person).
4. **Validação em ambiente real** (E2E autenticado por perfil, concorrência em banco real e carga)
   permanece não exercitada — itens P2 inalterados. Nada foi executado contra dados de produção.
5. **Retenção** de `AccessChangeEvidence` e `AuditLog` segue indefinida (decisão jurídica D-02).

### M.6 Classificação de risco revisada

| Item | Antes | Depois |
|---|---|---|
| Sobrescrita do token de ocorrência / evidência perdida | P1 | **Encerrado** (gate + CAS; HTTP-48/49/51/53) |
| Reviewer reativado por e-mail coincidente | P1 | **Encerrado** (`person_id` como prova; SR-14..17) |
| Conta legada sem vínculo User↔Person | — | **Falha fechada** com caminho de regularização (SR-17) |
| Alteração de papel bloqueada aguardando auditoria | — | **Risco operacional aceito e documentado** (M.5.1/2) |
| Validação em ambiente real / carga | P2 | **P2 — pendente** (homologação) |

**P1 = 0 nesta rodada** significa: os dois defeitos apontados não são mais reproduzíveis nos testes
adversariais nem no código revisado. Não é declaração de ausência geral de riscos: os itens P2 e os
riscos operacionais acima permanecem abertos, e a Fase 3 continua condicionada à revisão
independente e à homologação em ambiente real.
