# Auditoria — CFP e Cases de premiação (2026-11-06)

Revisão de leitura, sem alteração de código ou dados. Escopo: submissões de Call for Papers,
inscrições de cases, avaliação pela banca, decisão de curadoria/gestão, papéis e convites
envolvidos nos dois fluxos.

Base de dados inspecionada: **Produção** (modo atual do app). A base de Teste não foi auditada.

---

## 1. Resumo executivo

Os dois fluxos **nunca foram exercitados em produção**: existem 3 chamadas de CFP e 3 premiações
ativas, mas **zero** propostas, **zero** cases, **zero** avaliações e **zero** vínculos de curador
ou avaliador. Todo o desenho de permissões está implementado e fechado no servidor (nenhuma tela
escreve direto em `Submission`/`AwardSubmission`), mas os problemas abaixo só aparecem quando
alguém usar de verdade.

Três bloqueios concretos:

1. **A premiação não consegue ser avaliada hoje**: as 3 premiações ativas estão sem critérios e sem
   banca. Sem critério, `saveEvaluation` recusa a nota (409) e o avaliador não tem como pontuar;
   a tela de configuração salva nesse estado sem avisar.
2. **Cancelar uma proposta aprovada não desfaz o palestrante**: a sessão sai da grade, mas o
   `Participant` continua como palestrante no evento, com acesso, listas e contadores intactos.
3. **Aprovação pode ficar presa em "aprovada sem sessão"**: a decisão grava o status antes de criar
   participante e sessão; se a execução morrer no meio, a proposta não pode ser aprovada de novo.

Fora disso, a base está sólida em autorização por evento (admin ou membership do próprio evento),
em validação de conteúdo/respostas no servidor e em isolamento de escrita. O que falta é
**trilha de auditoria nas decisões de premiação**, **simetria entre os dois fluxos** (editar/excluir)
e **fechar a porta dupla de concessão do papel de avaliador**.

---

## 2. Escopo e método

| Fonte | O que foi lido |
|---|---|
| Portas de escrita | `manageSubmission` (413 linhas), `manageAward` (429), `manageEventRole` (161), `manageEventInvite` (80), `manageEventConfig` (leitura pública de CFP/premiação), `manageParticipant.setReviewer` |
| Regras compartilhadas | `shared/submissionForm.ts` (validação), `shared/identity.ts` (identidade), `shared/eventAuth.ts` (papéis por evento), `shared/eventInvites.ts` (convites/vínculos) |
| Esquemas | `Submission`, `CallForPapers`, `AwardConfig`, `AwardSubmission`, `AwardEvaluation`, `AwardCategory`, `AwardNomination`, `EventMembership` |
| Telas | `CallForPapersList`, `CFPSubmit`, `AwardsList`, `AwardSubmit`, `CurationPanel`, `SubmissionsReview`, `CallForPapersManager`, `PendingCFPSessions`, `AwardSubmissionsManager`, `AwardResultsView`, `AssignBancaDialog`, `AwardConfigFormDialog`, `SubmissionsSection`, `AssignedSubmissions`, `EvaluationForm`, `EditRolesDialog`/`EventRolesDialog`, `AdminHome` |
| Testes | `tests/e2e/rls-award-cfp-adversarial.authstate.spec.js`, `manager-regression.spec.js`, `TEST-CATALOG.md`, `TEST-PLAN.md`, specs de RLS direto |
| Dados | Contagens agregadas por status, órfãos, duplicidades e uso de campos (sem nomes, e-mails ou conteúdo) |

Método: rastrear cada ação da interface até a função que a executa, conferir a autorização no
servidor correspondente e comparar com o que o esquema e os testes afirmam.

Limite declarado: **ausência de dado não prova ausência de uso.** Onde a conclusão depende de
dados (campos nunca preenchidos, duplicidades), o relatório marca como "sem evidência hoje —
base vazia", não como "regra inútil".

---

## 3. Fluxos por perfil

### CFP (Call for Papers)

```
Candidato (qualquer usuário ativo)
  /cfp → lista chamadas abertas (manageEventConfig, somente leitura pública sanitizada)
  /cfp/:id/submit → manageSubmission.create  → status "pending"
  edita          → manageSubmission.update   (só se "pending" e janela aberta)
  exclui         → manageSubmission.delete   (só se "pending"; soft delete)
  reutiliza      → manageSubmission.clone    (cria cópia "pending" em outra chamada)
  acompanha      → manageSubmission.mine

Curador (EventMembership{curator}) ou Gestão (manager/team)
  /curation → manageSubmission.list (escopo dos eventos dele)
  aprova    → cria Participant{speaker} + Session na grade + status "approved"
  reprova / lista de espera / cancela

Gestão do evento
  módulo CFP → cria/edita chamadas e form_config (manageEventConfig, manager/team)
  triagem → PendingCFPSessions: sessões aprovadas sem sala/trilha/horário
```

### Cases de premiação

```
Candidato (entrant)
  /awards → lista premiações abertas (manageEventConfig) + "Minhas inscrições" (manageAward.myCases)
  /awards/:id/submit → manageAward.submitCase → status "pending" + EventMembership{entrant}
  (não edita, não exclui, não retira)

Banca (EventMembership{reviewer} + id em AwardConfig.assigned_reviewer_ids)
  /reviewer-dashboard → manageAward.listMyAssignments
  avalia → manageAward.saveEvaluation (nota por critério, total ponderado no servidor)

Gestão do evento (manager/team)
  módulo Premiação → cria premiação, form_config, criteria_config, banca (assignReviewers)
  acompanha → listSubmissions / listResults (ranking por média)
  decide    → setStatus (andamento) ou promoteWinner (status + papel no evento)
```

---

## 4. Matriz de permissões (verificada no servidor)

| Ação | Autor | Curador | Avaliador | Gestão (manager/team) | Admin |
|---|---|---|---|---|---|
| Listar chamadas/premiações abertas | sim (leitura pública sanitizada) | sim | sim | sim | sim |
| Criar proposta / case | sim (própria) | — | — | — | sim (como autor) |
| Editar / excluir proposta | só `pending`, dentro da janela | — | — | — | sim, via autor |
| Editar / excluir case | **não existe** | — | — | — | **não existe** |
| Ver fila de curadoria | — | próprio evento | — | próprio evento | todos |
| Decidir proposta | — | próprio evento | — | próprio evento | todos |
| Criar/editar chamada, premiação, critérios | — | — | — | próprio evento | todos |
| Designar banca | — | — | — | próprio evento | todos |
| Conceder/revogar curador e avaliador | — | — | — | **só `manager`** (não `team`) | todos |
| Ver ranking / resultados | — | — | — | próprio evento | todos |
| Promover vencedor (concede acesso) | — | — | — | próprio evento | todos |
| Avaliar case | — | — | banca + papel ativo | **não** | **sim, sempre** |

Observações da matriz:
- Escrita direta via SDK em `Submission`, `AwardSubmission`, `AwardEvaluation`, `AwardConfig`,
  `CallForPapers` está travada para admin — as portas reais são as funções. Confirmado no código e
  em `rls-award-cfp-adversarial`.
- `listResults` e `assignReviewers` aceitam `team`; conceder papel de curador/avaliador, não. É
  intencional, mas significa que a equipe opera a premiação sem poder incluir avaliadores.
- Curador **não** lista papéis nem vê a banca; avaliador não vê nada além dos próprios cases.

---

## 5. Validações e campos

### O que é validado no servidor (fronteira real)

| Regra | Onde |
|---|---|
| Título 3–200, resumo obrigatório ≤5000, tipo em lista fechada | `submissionForm.validateContent` |
| Campos obrigatórios do `form_config`, opções válidas, resposta ≤3000, chaves fora do formulário descartadas | `submissionForm.validateAnswers` |
| Janela de submissão, `is_active`, status `pending` para editar/excluir | `manageSubmission` |
| Autoria por identidade canônica (person_id → e-mails normalizados → created_by) | `identity.resolveIdentity` |
| Evento do case = evento da premiação; nota numérica, ≥0, ≤ máximo, critério existente | `manageAward.saveEvaluation` |
| Banca exige papel `reviewer` ativo; promoção exige conta ativa | `manageAward` |
| Transições de status fechadas por tabela (`approve/reject/waitlist/cancel`) | `manageSubmission.TRANSITIONS` |
| Claim atômico (dois curadores não geram duas sessões) | `claimDecision` |

### Campos e regras sem uso observável

| Item | Situação | Evidência |
|---|---|---|
| `AwardSubmission.assigned_reviewer_ids` | gravado como `'[]'` no `submitCase` e **nunca** atualizado; a banca real é do prêmio (`AwardConfig`) | 0 registros com valor |
| `AwardEvaluation.status` (`draft`/`submitted`) | gravado sempre `'submitted'`; nada lê o campo; o formulário envia `status` e o servidor ignora | código |
| `AwardCategory` | 0 registros, nenhuma referência em telas ou funções (só um spec de teste) | busca em `src/` e `base44/` |
| `AwardNomination` | idem | idem |
| `Submission.original_submission_id` | usado na UI como selo "reusada"; útil, mas sem regra de negócio | 0 registros (base vazia) |
| `CallForPapers.description` | exibido ao candidato — ok | — |
| `AwardConfig.description` | exibido ao candidato e ao avaliador — ok | — |

---

## 6. Testes e cobertura

| Área | Cobertura existente | Lacuna |
|---|---|---|
| RLS direto em `AwardConfig`/`CallForPapers` | bloqueado para não-admin; leitura pública sem campos sensíveis | ok |
| CRUD de configuração por gestão | `manageEventConfig` dentro do evento; escrita direta bloqueada | ok |
| Telas de CFP e premiação carregam | `GM-040/041` (manager) | smoke apenas |
| **Submissão → decisão → sessão** | **nenhum teste** | dupla aprovação, cancelamento, janela, reabertura |
| **Case → banca → ranking → promoção** | **nenhum teste** | nota inválida, banca incompleta, promoção sem conta |
| **Convite de curador/avaliador → acesso** | **nenhum teste** | vínculo pendente, ativação no primeiro acesso, revogação |
| Identidade ambígua (um e-mail → 2 Persons) | sem teste nos fluxos | negação esperada nunca exercitada |

O catálogo (`TEST-CATALOG.md`) cobre o tema apenas com duas linhas de gestão. Não há teste de
nenhuma transição de estado de proposta ou case.

---

## 7. Dados observados (Produção, 2026-11-06)

- 10 eventos, 10 contas de usuário.
- 3 chamadas de CFP (todas ativas), 3 premiações (todas ativas).
- **0** propostas, **0** cases, **0** avaliações, **0** categorias, **0** indicações.
- **0** vínculos de curador; **0** vínculos de avaliador (nem ativos, nem pendentes).
- 4 participantes com papel de palestrante; nenhuma sessão originada de CFP.
- **3 de 3** premiações sem `criteria_config` e sem banca designada.
- Integridade: nenhum registro órfão (proposta sem chamada, case fora do prêmio, avaliação sem
  case) e nenhuma duplicidade — o que aqui reflete a base vazia, não a correção do código.

Leitura: o primeiro uso real vai encontrar a premiação em estado não avaliável e nenhum avaliador
designado.

---

## 8. Achados priorizados

### P0 — bloqueiam o primeiro uso real

**A-01. Premiação sem critérios e sem banca (estado atual das 3 ativas).**
`saveEvaluation` recusa a nota quando `criteria_config` está vazio (409) e `listMyAssignments`
devolve vazio sem banca. A tela de configuração aceita salvar sem critérios e sem avisar que a
avaliação fica impossível.
*Recomendação:* exigir ao menos um critério ao ativar a premiação e mostrar pendência
("sem critérios" / "sem banca") na lista de premiações da gestão.

**A-02. Cancelar proposta aprovada deixa o palestrante no evento.**
`manageSubmission` (cancel) faz soft delete da `Session` e mantém `Participant{role_in_event:
speaker}`, os contadores de participantes/papel e o `participant_id` na proposta. O palestrante
cancelado continua com acesso e recebendo comunicações.
*Recomendação:* ao cancelar, reverter o papel do participante (ou desativá-lo), devolver os
contadores e limpar `participant_id`; confirmar via `reconcileParticipantCounters`.

**A-03. Estado intermediário "aprovada sem sessão".**
O claim grava `status: approved` antes de criar participante e sessão. Falha no meio (timeout)
deixa a proposta aprovada sem sessão, e `approve` não é mais aceito ('approved' fora das
transições). Não há tela que mostre nem corrija isso.
*Recomendação:* aceitar `approve` em `approved` **sem** `session_id` (retomada idempotente), ou
usar um status intermediário próprio para o claim.

### P1 — risco de permissão, consistência e rastreabilidade

**A-04. Decisões de premiação sem trilha.**
CFP grava `reviewer_id`, `reviewer_name` e notas; premiação não grava autor da decisão nem data,
e nenhum dos dois grava `AuditLog`. Não é possível reconstruir quem marcou um case como vencedor.
*Recomendação:* gravar `decided_by`/`decided_at` em `AwardSubmission` e registrar em `AuditLog`
nas ações de status e promoção (o `logAuditEvent`/`shared/auditTrail` já existem).

**A-05. Duas portas para conceder o papel de avaliador, com regras diferentes.**
`manageParticipant.setReviewer` (tela Pessoas → marcar "Avaliador") cria o vínculo **ativo, com
`user_id` possivelmente vazio e sem convite**; `manageEventRole.grant` exige conta e, sem conta,
cria convite pendente. Na revogação, só `manageEventRole` limpa a banca
(`assigned_reviewer_ids`) — revogar pela tela Pessoas deixa o id na banca.
*Recomendação:* unificar em `manageEventRole` (ou fazer `setReviewer` delegar nele) e limpar a
banca em qualquer caminho de revogação.

**A-06. Case não pode ser corrigido nem retirado pelo candidato.**
Não existe `updateCase`/`deleteCase` em `manageAward` nem ação na tela. O CFP permite editar e
excluir enquanto pendente; a premiação não. Erro de digitação no case só é corrigível pela gestão,
no banco.
*Recomendação:* espelhar o CFP — editar/excluir enquanto `pending` e dentro da janela.

**A-07. Ranking mistura premiações.**
Com `award_id` omitido ("Todas as premiações", padrão da tela), as avaliações são filtradas pelo
prêmio mas os cases continuam vindo de **todo o evento** — cases de prêmios diferentes entram no
mesmo ranking, e cases sem nota entram com 0,00.
*Recomendação:* filtrar cases pelo prêmio quando houver filtro e separar/omitir os não avaliados.

**A-08. Duplicidade de envio não é impedida.**
Nem `submitCase` nem `create` de proposta verificam (pessoa, prêmio) / (pessoa, chamada). Duplo
clique ou reenvio cria dois registros. Sem evidência hoje (base vazia); o risco é de uso.
*Recomendação:* recusar segundo envio idêntico na mesma janela (ou exigir confirmação explícita).

**A-09. Admin avalia fora da banca, sem marcação.**
`saveEvaluation` libera admin sem checar banca ou papel, e a nota entra no ranking indistinguível
de uma nota de avaliador. Se a intenção é permitir correção, isso precisa ser explícito e auditado.
*Recomendação:* registrar a origem (`admin_override`) e exibir no ranking, ou exigir banca.

**A-10. Erros silenciosos nos formulários do candidato.**
`CFPSubmit.submit()` e `AwardSubmit.submit()` retornam sem mensagem quando falta campo obrigatório,
e a inscrição de case não tem tratamento de erro na mutation — falha do servidor (janela fechada,
identidade ambígua, duplicidade) não aparece para o candidato.
*Recomendação:* toast de validação no cliente e `onError` na inscrição (o formulário de avaliação
já faz isso).

**A-11. Leitura de "minhas propostas" sem paginação.**
`mine` limita a 200 e `myCases` a 100, sem `has_more`. Autor com histórico longo perde registros
silenciosamente.
*Recomendação:* cursor ou limite explícito com aviso.

**A-12. Fila de curadoria carrega o evento inteiro em memória.**
`manageSubmission.list` devolve todas as submissões dos eventos do curador sem limite; a tela
filtra por status no cliente. Em evento grande encosta no teto da plataforma.
*Recomendação:* filtrar por status no servidor e paginar.

### P2 — limpeza e arestas de interface

**A-13.** `AwardSubmission.assigned_reviewer_ids` — campo morto; remover do esquema e do `submitCase`.
**A-14.** `AwardEvaluation.status` — sempre `'submitted'`, ninguém lê; remover ou implementar rascunho.
**A-15.** `AwardCategory` e `AwardNomination` — legado sem uso, duplicam `AwardConfig`/
`AwardSubmission`; remover junto do spec que os cita.
**A-16.** Banca "fantasma": id revogado permanece em `assigned_reviewer_ids` e não aparece na
lista do diálogo, mas é salvo de volta ao confirmar.
**A-17.** `f.options` como texto separado por vírgula é aceito pelo servidor, mas o `Select` da
tela faz `.map` e quebra. Configurações antigas nesse formato derrubam o formulário.
**A-18.** `SubmissionsSection` tem variável morta (`cfpEndPassed`) e mostra "editar" para propostas
fora da janela (o servidor recusa; a tela não avisa antes).
**A-19.** `AdminHome` lê `Submission` direto pelo SDK filtrando por `person_id`, apoiado em RLS por
e-mail, só para decidir se mostra o card do palestrante — proposta feita com outro e-mail esconde o card.
**A-20.** `CFPSubmit` não considera `start_date`/`is_active`: chamada desativada mostra spinner
eterno em vez de "não disponível".

---

## 9. Próximos passos sugeridos

**Fase 1 — destravar o primeiro uso (P0)**
1. A-01: exigir critério e sinalizar "sem banca" na gestão da premiação.
2. A-02: reverter participante e contadores no cancelamento.
3. A-03: retomada idempotente de aprovação sem sessão.

**Fase 2 — rastreabilidade e simetria (P1)**
4. A-04: `decided_by`/`decided_at` + `AuditLog` nas decisões de premiação.
5. A-05: porta única para papel de avaliador (e limpeza de banca na revogação).
6. A-06: editar/excluir case pendente.
7. A-07 e A-08: ranking por prêmio e bloqueio de envio duplicado.

**Fase 3 — higiene (P2)**
8. A-13 a A-16: aposentar campos e entidades legadas.
9. A-10, A-17 a A-20: mensagens de erro, formato de opções e arestas de tela.

**Testes a criar junto da Fase 1** (hoje inexistentes):
- duas aprovações simultâneas da mesma proposta → uma sessão, um conflito;
- cancelar proposta aprovada → sessão fora da grade **e** palestrante sem acesso;
- premiação sem critério → gestão vê pendência, avaliador não recebe designação inválida;
- convidar avaliador sem conta → vínculo pendente → ativação no primeiro acesso;
- revogar avaliador pelos dois caminhos → fora da banca nos dois.