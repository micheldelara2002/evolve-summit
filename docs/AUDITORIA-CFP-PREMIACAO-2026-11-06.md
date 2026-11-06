# Auditoria ampla — CFP, Premiação e papéis de evento (2026-11-06)

Revisão da implementação existente antes da bateria de testes do time. Nenhum dado de
produção foi alterado.

## Correções aplicadas

### 1. Decisão de CFP não pode virar duas sessões
`manageSubmission` decidia em duas etapas (ler status → criar sessão/participante →
gravar). Dois curadores clicando juntos aprovavam a mesma proposta duas vezes.
- Claim atômico por escrita condicional + token irrepetível em `reviewer_id`; o perdedor
  recebe `409` e recarrega a fila.
- Falha no meio devolve a submissão ao estado lido (`releaseClaim`), sem deixar
  "aprovada sem sessão".
- Aprovar de novo uma submissão já aprovada é idempotente (devolve a sessão existente).

### 2. Integridade de vínculo evento ↔ chamada
Se `Submission.event_id` divergir de `CallForPapers.event_id` (registro legado), a decisão
é recusada (`409`) em vez de criar sessão no evento errado.

### 3. Leitura do próprio autor sem depender de RLS por e-mail
A lista "Minhas submissões" e a tela de edição liam via SDK, apoiadas em
`data.submitter_email == {{user.email}}` — comparação sensível a maiúsculas. Agora o
servidor resolve a identidade canônica (`person_id`, e-mails normalizados, autoria):
- `manageSubmission` → `action: "mine"`
- `manageAward` → `action: "myCases"`
Usados por Painel do Palestrante, seção "Minhas Submissões", formulário de edição e
"Minhas inscrições" das premiações.

### 4. Premiação: banca, ranking e promoção
- `saveEvaluation` exige que a premiação e o case sejam do **mesmo evento**.
- `listMyAssignments` consulta apenas as premiações da banca (antes carregava a tabela
  inteira e filtrava em memória, com risco de truncar em 1000 registros).
- `promoteWinner` recusa conceder acesso a conta excluída.
- `setStatus` recusa `winner`: declarar vencedor só pela promoção, que é o caminho que
  valida a conta e concede o papel no evento. O seletor de status na gestão segue a
  mesma regra.

### 5. Papéis: revogar avaliador tira da banca
`manageEventRole.revoke` encerrava o `EventMembership`, mas o `user_id` continuava em
`AwardConfig.assigned_reviewer_ids`. Quem recebesse o papel de novo reentrava na banca
sem ninguém designar. A revogação agora limpa as bancas do evento.

### 6. Erros silenciosos na interface
- `EvaluationForm` engolia rejeições do servidor (o diálogo ficava aberto sem explicação).
- `AwardSubmissionsManager` não tratava falha da promoção (ex.: candidato sem conta).
- "Reavaliar" abria o formulário sem as notas salvas (`existing` não era repassado).

### 7. Legado
`AwardCategory` e `AwardNomination` não são lidos nem escritos por nenhuma tela ou função
do app — só aparecem em um spec de teste. Permanecem no banco (RLS admin-only) como
histórico; não há caminho paralelo que contorne `manageAward`.

## Cenários de regressão (por perfil)

**Autor / candidato**
1. Enviar proposta em chamada aberta → aparece como Pendente em "Minhas Submissões".
2. Editar a proposta pendente → conteúdo atualiza; status não muda.
3. Tentar editar/enviar depois do `end_date` → recusado com mensagem clara.
4. Reutilizar proposta em outra chamada aberta → cópia pendente, original intacta.
5. Excluir proposta pendente → some da lista; excluir aprovada → recusado.
6. Inscrever case em premiação aberta → aparece em "Minhas inscrições".
7. Inscrever fora da janela / premiação inativa → recusado.

**Curador**
8. Aprovar proposta → vira Palestrante no evento e a sessão nasce na grade.
9. Aprovar a mesma proposta de novo → resposta idempotente, sem segunda sessão.
10. Duas abas aprovando a mesma proposta → uma vence, a outra recebe conflito.
11. Reprovar / lista de espera / cancelar aprovada → status correto; cancelar remove a
    sessão da grade.
12. Abrir a fila de um evento onde não é curador → vazio/403 (nunca dados de outro evento).

**Avaliador**
13. Ver só os cases das premiações em que está na banca.
14. Enviar nota acima do máximo / critério inexistente → recusado.
15. Reavaliar → notas anteriores carregadas e substituídas.
16. Após perder o papel de avaliador → painel vazio e `saveEvaluation` recusado.

**Gestor / admin**
17. Designar banca com pessoa sem papel de avaliador ativo → recusado com a lista.
18. Promover candidato sem conta → recusado orientando o convite.
19. Promover vencedor → acesso ao evento concedido; status `winner`.
20. Trocar status para "Vencedor" pelo seletor → recusado (usar Promover).
21. Ranking agrega média e nº de avaliações por case.

**Convites e identidade**
22. Convidar curador/avaliador com conta → vínculo imediato e aparece na lista.
23. Convidar sem conta → convite pendente; ao criar a conta, o papel ativa sozinho.
24. Revogar avaliador → sai da lista **e** da banca das premiações do evento.
25. E-mail com caixa diferente da cadastrada → continua vendo as próprias propostas.