# Plano de correção priorizado — Evolve Summit

**Data:** 2026-11-04
**Origem:** Diagnóstico de regras de negócio, acessos e permissões (revisão estática de funções de backend, regras RLS e guards de rota).
**Escopo:** corrigir os riscos levantados no diagnóstico, sem ampliar permissões nem alterar regras de negócio já aprovadas.

---

## 1. Decisões aprovadas

| # | Decisão | Efeito no plano |
|---|---|---|
| D1 | Falha na gravação de auditoria obrigatória **bloqueia** a operação financeira. | Fase P0-B define ponto de bloqueio, compensação e reconciliação. |
| D2 | Implantação em **fases com validação**, avançando só após os critérios de aceite passarem. | Nenhuma fase começa antes do aceite formal da anterior. |
| D3 | Testes de aceite cobrem **todos os perfis** do diagnóstico. | Matriz de aceite por perfil (§8) obrigatória em toda fase. |

## 1.1 Status de execução

| Fase | Status | Observações |
|---|---|---|
| P0-A | **Concluída** | Validação em `base44/shared/commerceValidation.ts`, aplicada em `manageCommerce` (TicketType, SalesLot, Coupon e política de estorno). Recusas por campo verificadas; caminho válido verificado. |
| P0-B | Não iniciada | Aguarda aceite de P0-A. |
| P1-A · P1-B · P1-C · P2 | Não iniciadas | — |

**Decisões provisórias adotadas em P0-A** (§11, itens 1 e 2): preço de lote e desconto fixo até R$ 1.000.000,00; código de cupom de 3 a 40 caracteres (`A-Z 0-9 _ -`). Ajustar aqui se a regra de negócio for outra.

## 2. Regras de execução

1. **Backend é a autoridade.** Nenhuma fase pode depender de guard de frontend para autorização, validação ou elegibilidade.
2. **Nada de validação silenciosa.** Valores inválidos são **recusados** (4xx com motivo), não normalizados para um valor "próximo".
3. **Preservar o que já funciona:** isolamento por evento/parceiro; estorno elegível cancela integralmente ingresso e participação afetados; estorno com check-in confirmado permanece bloqueado até reversão manual; pagamento só é confirmado pelo fluxo autoritativo do Stripe.
4. **Efeito externo antes da falha nunca se repete às cegas.** Se o provedor pode já ter executado a operação, o caso vai para estado pendente + reconciliação; sucesso **não** é comunicado ao usuário até estado e trilha estarem consistentes.
5. **Sem dado de produção em validação.** Pagamentos e estornos são testados no ambiente de teste; os passos de produção são validados separadamente antes de liberar.
6. **Uma fase = um patch reviewável.** Se uma fase não couber em uma entrega coesa, ela é dividida em sub-entregas numeradas, mantendo o mesmo critério de aceite.

## 3. Visão geral

| Fase | Prioridade | Tema | Depende de |
|---|---|---|---|
| P0-A | P0 | Validação server-side de dados financeiros | — |
| P0-B | P0 | Auditoria financeira obrigatória (bloqueante) | P0-A |
| P1-A | P1 | Identidade canônica User→Person→Participant | P0-B |
| P1-B | P1 | Consultas, paginação e minimização de dados | P1-A |
| P1-C | P1 | Concorrência e idempotência (pontos e conexões) | P1-A |
| P2 | P2 | Exclusão de conta e retenção de histórico | P1-A, P1-B |

`P0-A` e `P0-B` são pré-requisitos de tudo: enquanto valores financeiros não são validados e a trilha não é obrigatória, qualquer correção posterior opera sobre base instável.

---

## 4. Fase P0-A — Validação server-side de dados financeiros

### Objetivo
Garantir que nenhum valor inválido, incoerente ou fora de faixa seja persistido em configuração comercial e de política de estorno.

### Riscos tratados
- Persistência de preço, quantidade, desconto, datas e limites de uso apenas filtrados por lista de campos, sem validação de domínio.
- Política de estorno gravada como JSON sem validação de estrutura e limites.
- Configuração incoerente de lote/cupom gerando venda em condição inesperada.

### Escopo
- **TicketType:** nome não vazio e com limite de tamanho; `sort_order` inteiro; `is_active` booleano.
- **SalesLot:** `price` finito, ≥ 0 e com teto máximo definido; `quantity_total` inteiro ≥ 0; `sale_start` e `sale_end` válidos e `start < end`; moeda suportada; vínculo com `ticket_type_id` pertencente ao mesmo evento.
- **Coupon:** código normalizado (maiúsculas, sem espaços) com formato e comprimento definidos; `discount_type` e `value` coerentes (percentual entre 0–100 exclusivo no zero; valor fixo positivo e limitado ao preço de referência do evento); `valid_from < valid_to`; `max_uses` inteiro ≥ 0; `scope` válido.
- **Política de estorno (`setPolicy`):** somente chaves conhecidas; percentuais 0–100; dias inteiros ≥ 0; relação coerente entre a janela de estorno integral, o percentual parcial e a janela sem estorno; recusa de payload com chaves desconhecidas.
- **Campos numéricos correlatos** (`requires_payment`, override de comissão do evento, quando editáveis pela mesma superfície): faixa validada na gravação.
- **Erro por campo.** A resposta lista os campos inválidos; nada é gravado; operações válidas mantêm o comportamento atual.

### Dependências
Nenhuma. É a primeira fase.

### Critérios de conclusão
1. Todos os campos citados têm validação server-side explícita, com testes de fronteira (mínimo−1, mínimo, máximo, máximo+1, `NaN`, `Infinity`, string numérica, `null`, ausente).
2. Payload inválido retorna erro por campo e **nenhum** registro é criado ou alterado.
3. Payload inválido em `update` preserva o registro anterior intacto.
4. Cupom com código duplicado continua recusado (comportamento atual preservado) e a recusa não deixa código órfão no registro do evento.
5. Fluxo de compra válido (criar tipo → lote → cupom → checkout em ambiente de teste) conclui sem regressão.
6. Política de estorno válida continua decidindo igual ao comportamento anterior para os mesmos dados.

### Testes de aceite
- Payloads malformados por entidade (matriz acima) via chamada direta à função, não pela interface.
- Regressão positiva: criação e edição válidas, listagem e diagnóstico de códigos duplicados preservados.
- Compra ponta a ponta no ambiente de teste com lote criado pelas novas validações.

---

## 5. Fase P0-B — Auditoria financeira obrigatória (bloqueante)

### Objetivo
Tornar a trilha de auditoria parte do contrato das operações financeiras: sem trilha, não há conclusão nem confirmação de sucesso (**D1**).

### Riscos tratados
- Auditoria tratada como *best effort* em fluxos que alteram pagamento, pedido, ingresso e participação.
- Estado financeiro alterado sem evidência correspondente.
- Falha intermediária deixando estados parciais sem rastro para reconciliação.

### Escopo
1. **Classificar as escritas de auditoria** em dois tipos:
   - **Obrigatória:** toda transição de valor ou estado financeiro (início de checkout, pagamento confirmado, pagamento cancelado/expirado, emissão de ingressos, estorno solicitado, estorno confirmado, falha de estorno, alteração de preço/lote/cupom/política de estorno, operações de repasse).
   - **Auxiliar:** telemetria, contadores de leitura, eventos de engajamento — permanecem best-effort.
2. **Auditoria com verificação de resultado.** A escrita obrigatória precisa retornar confirmação; erro ou ausência de confirmação é tratado como falha, não ignorado.
3. **Dois pontos de bloqueio distintos:**
   - **Antes de efeito externo** (ex.: abrir cobrança, disparar estorno): falha na auditoria ⇒ operação não inicia, retorno de indisponibilidade, nenhuma cobrança ou estorno criado.
   - **Depois de efeito externo** (ex.: Stripe já confirmou o pagamento): não repetir a chamada externa; registrar o caso como pendente de trilha, reconciliar com o provedor, e **não** comunicar sucesso até que estado e trilha estejam consistentes.
4. **Compensação sem efeito colateral.** Quando o bloqueio ocorrer depois de reservas/locks locais, devolver reserva de teto de estorno, destravar ingressos (`refund_pending` → `issued` escopado por dono da trava) e devolver uso de cupom — nada fica preso.
5. **Idempotência da trilha.** Repetição da mesma operação (webhook duplicado, retry, replay de polling) não duplica registro obrigatório; a chave é derivada da operação, não do horário.
6. **Rastreabilidade do caso pendente.** Registro consultável com identificador da operação, provedor, valor, referência externa e motivo da falha — suficiente para o reconciler concluir depois.

### Dependências
P0-A concluída (valores já confiáveis antes de virarem trilha).

### Critérios de conclusão
1. Existe lista fechada e revisada de operações com auditoria obrigatória.
2. Falha simulada de escrita **antes** do efeito externo: operação não executa, nenhum objeto é criado no provedor, reservas não ficam presas, resposta é de erro e não de sucesso.
3. Falha simulada de escrita **depois** do efeito externo: nenhuma segunda cobrança/estorno é disparada, o caso fica pendente e rastreável, e nenhuma tela informa sucesso.
4. Repetição da mesma operação (webhook duplicado, retry manual) não gera trilha duplicada nem segundo efeito financeiro.
5. Job de reconciliação conclui casos pendentes de trilha e registra o desfecho.
6. Fluxo feliz de compra, cancelamento e estorno continua concluindo normalmente no ambiente de teste.

### Testes de aceite
- Injeção de falha na escrita de auditoria em cada ponto de bloqueio mapeado.
- Reenvio do mesmo evento de webhook e retry manual do estorno.
- Verificação de que nenhum ingresso permanece em `refund_pending` após bloqueio.
- Verificação de que teto de estorno reservado é devolvido quando a operação não conclui.

---

## 6. Fase P1-A — Identidade canônica User→Person→Participant

### Objetivo
Uma única resolução de identidade para todas as decisões de posse e autorização.

### Riscos tratados
- Caminhos que usam somente `Person.contact_email` enquanto outros usam `user.person_id` com fallback.
- Escolha silenciosa da "primeira" Person quando existe mais de uma correspondência.
- Comparações de e-mail sensíveis a maiúsculas/minúsculas.
- Recusa indevida de usuário legítimo (ou decisão de posse incorreta) em conexões, presença, campanhas e leituras próprias.

### Escopo
1. **Adotar o resolvedor compartilhado** como única porta de entrada em todos os fluxos que dependem de identidade, incluindo envio, aceite, recusa e cancelamento de pedidos de conexão (substituindo lookups locais por e-mail).
2. **Precedência explícita:** vínculo `person_id` verificado > e-mail normalizado > nenhum. Documentar a ordem em um único lugar.
3. **Normalização de e-mail:** chave canônica na gravação e comparação normalizada em todas as leituras.
4. **Ambiguidade não é escolha:** múltiplas Persons correspondentes ⇒ negar a operação sensível e sinalizar exigência de resolução (nunca "pega a primeira").
5. **Participant:** resolver por `person_id` OU e-mail normalizado, sem depender de varredura da lista do evento.

### Dependências
P0-B (trilha obrigatória já garante registro de mudanças de vínculo).

### Critérios de conclusão
1. Nenhum fluxo mantém lookup de identidade próprio por `contact_email`.
2. Uma única função define precedência e ambiguidade, e todos os chamadores a usam.
3. Matriz de identidade aprovada: com `person_id`; sem `person_id`; e-mail divergente do de login; caixa diferente; múltiplas correspondências; conta sem Person.
4. Casos ambíguos resultam em **negação** com motivo claro, não em autorização parcial.
5. Fluxos legítimos de conexão, presença, campanha e leitura própria continuam funcionando para os perfis afetados.

### Testes de aceite
- Chamadas diretas ao backend com cada combinação da matriz de identidade.
- Tentativa de operar sobre participante de terceiro → negada.
- Tentativa com e-mail de terceiro em caixa diferente → negada.
- Usuário com vínculo explícito e e-mail divergente → autorizado pelo vínculo.

---

## 7. Fase P1-B — Consultas, paginação e minimização de dados

### Objetivo
Eliminar leituras sem limite, filtros que deveriam estar no banco e payloads acima do necessário.

### Riscos tratados
- Registros próprios carregados sem paginação.
- Listagem "meus eventos" com busca ampla em uma única consulta e retorno incluindo registros cancelados.
- Procura do próprio participante em lista completa do evento.
- Escopo de participantes/palestrantes em consultas de parceiro sem filtro de evento explícito.
- Campos pessoais além do necessário por finalidade.

### Escopo
1. **Paginação por cursor** em toda leitura potencialmente grande de participantes, sessões e listas de evento; resposta com `has_more`/`next_cursor`, sem duplicação entre páginas.
2. **Filtros no banco:** elegibilidade, status de inscrição e estado de presença filtrados na consulta quando a regra funcional exigir.
3. **Resolução pontual:** buscar o participante do chamador por filtro direto (pessoa/e-mail) em vez de carregar a lista do evento.
4. **Minimização por perfil:** definir, por tela e perfil, os campos indispensáveis; listas de terceiros não recebem identificadores de pessoa nem contato além do necessário.
5. **Decisão explícita de escopo de parceiro:** consultas de parceiro passam a exigir escopo (evento e/ou parceiro) definido, não herdado implicitamente.
6. **Contagens server-side** onde a interface mostra totais.

### Dependências
P1-A (identidade confiável define "meus" registros corretamente).

### Critérios de conclusão
1. Nenhuma leitura de participantes ou sessões sem limite/`skip` implícito em caminho de alto volume.
2. Teste de volume (base com milhares de participantes e centenas de sessões) percorre todas as páginas sem duplicar nem perder registros.
3. Registros cancelados/inelegíveis aparecem exatamente onde a regra manda e somem onde não manda.
4. Cada perfil recebe apenas o conjunto de campos aprovado na matriz.
5. Consultas de parceiro têm escopo explícito e recusam chamada sem escopo.

### Testes de aceite
- Carga sintética em ambiente de teste com paginação completa.
- Comparação de contagem entre tela, contagem server-side e soma das páginas.
- Chamada direta ao backend com parâmetros de paginação manipulados (cursor inválido, `skip` negativo, limite acima do teto).

---

## 8. Fase P1-C — Concorrência e idempotência

### Objetivo
Garantir um único estado vencedor em transições concorrentes e consistência entre ledger de pontos e contador.

### Riscos tratados
- Transições de pedido de conexão (aceitar/recusar/cancelar) atualizadas após leitura de estado, sem comparação condicional.
- Pontuação por sequência criar→deduplicar→incrementar, sem atomicidade entre transação e contador.
- Divergência entre `PointTransaction` e `Participant.points_total` após falha intermediária.

### Escopo
1. **Conexões:** toda transição condiciona-se ao estado esperado (`pending`); apenas o vencedor cria a conexão, notifica e dispara pontuação. Perdedor recebe estado atual idempotente.
2. **Pontuação:** definir `PointTransaction` como **fonte de verdade** do crédito; impedir criação duplicada por mecanismo atômico antes do incremento; tratar `points_total` como contador derivado e reconciliável.
3. **Crédito idempotente:** repetição da mesma ação (mesma chave) nunca credita duas vezes, mesmo com requisições simultâneas.
4. **Reconciliação:** rotina existente passa a ser o caminho de correção, com relatório de divergência antes de reescrever.

### Dependências
P1-A (identidade e posse estáveis antes de testar concorrência).

### Critérios de conclusão
1. Disparos paralelos repetidos de aceitar/recusar/cancelar produzem exatamente um estado final e nenhuma conexão duplicada.
2. Disparos paralelos da mesma ação de pontuação resultam em um único crédito.
3. Falha injetada entre criação da transação e incremento não deixa contador inconsistente sem sinalização; reconciliação converge para o valor do ledger.
4. Nenhum crédito em dobro após reprocessamento de ação já creditada.

### Testes de aceite
- Rajada concorrente (mesmo par de participantes, múltiplos pedidos simultâneos).
- Rajada da mesma ação de pontuação com prova de evidência presente.
- Falha injetada + execução da reconciliação + verificação de convergência.

---

## 9. Fase P2 — Exclusão de conta e retenção

### Objetivo
Garantir anonimização consistente em todos os cenários de vínculo e tornar explícito o que é preservado.

### Riscos tratados
- Dependência de `person_id` para parte das etapas, deixando usuários sem vínculo com dados não alcançados.
- Vínculos por e-mail divergente ou histórico inconsistente sobrevivendo à exclusão.
- Preservação de histórico sem política declarada por categoria.

### Escopo
1. **Cobertura por vínculo:** com Person; sem Person; e-mail divergente; múltiplos eventos; registros ligados a parceiro.
2. **Matriz de dados:** para cada entidade tocada — anonimizado, preservado (justificativa) ou excluído.
3. **Retenção documentada:** histórico financeiro e de participação preservado de forma não identificável, com prazo/justificativa registrados.
4. **Execução idempotente:** repetição confirma o mesmo resultado sem novas perdas.

### Dependências
P1-A e P1-B (identidade e leitura próprias confiáveis).

### Critérios de conclusão
1. Matriz de exclusão completa e revisada.
2. Nenhum dado identificável remanescente nos cenários da matriz, exceto o explicitamente aprovado.
3. Repetição da exclusão é idempotente.
4. Nenhuma métrica histórica (pontos, ranking, contadores) é alterada pela anonimização.

### Testes de aceite
- Execução em ambiente de teste para cada cenário da matriz, com verificação de campos por entidade.
- Execução repetida (segunda chamada) e verificação de estabilidade.
- Verificação de que totais de métricas permanecem iguais antes e depois.

---

## 10. Matriz de aceite por perfil (obrigatória em toda fase)

Colunas: acesso pela interface · chamada direta ao backend · escopo entre eventos · escopo entre parceiros · conta ativa/excluída · operação válida · operação negada · concorrência · falha de escrita.

| Perfil | Foco adicional de verificação |
|---|---|
| **Admin** | Acesso global, mas invariantes financeiras e de dados continuam valendo; ações de alto impacto exigem estado válido. |
| **Manager de evento** | Gestão somente em eventos com vínculo ativo; acesso financeiro separado; toda função confere o evento solicitado, não apenas a existência de algum vínculo. |
| **Team / staff** | Operação sem acesso financeiro; alterações limitadas ao evento correto; PII exibida apenas o necessário. |
| **Participante / attendee** | Registros próprios por vínculo e por e-mail; elegibilidade e cancelamento respeitados; presença e pontuação com evidência. |
| **Palestrante** | Avaliações, perguntas, presença e participantes apenas das próprias sessões; nenhum poder de gestão herdado. |
| **Partner manager** | Leads e dados do parceiro limitados ao escopo declarado; vínculo revalidado em cada operação sensível. |
| **Representante de parceiro** | Leitura conforme vínculo; diferença entre ler e editar documentada e respeitada. |
| **Reviewer** | Somente submissões atribuídas; nenhuma leitura de outros eventos. |
| **Curator** | Revisão de submissões do evento, sem acesso a dados financeiros ou de gestão. |
| **Entrant** | Apenas as próprias submissões; sem acesso ao evento ou a dados de outros candidatos. |
| **Winner** | Acesso liberado apenas ao previsto; nenhuma herança automática de papel de gestão. |

**Regra de aceite:** uma fase só é concluída quando a matriz estiver executada nos pontos afetados por ela, com interface **e** chamada direta ao backend, e sem regressão nos demais perfis.

---

## 11. Dependências e decisões de negócio em aberto

Estes pontos precisam de decisão antes da fase correspondente; nenhum deve ser resolvido implicitamente no código.

| # | Decisão necessária | Fase |
|---|---|---|
| 1 | Teto máximo aceito para preço de lote e para desconto fixo de cupom. | P0-A |
| 2 | Formato e comprimento padrão de código de cupom. | P0-A |
| 3 | Relação exata entre janela de estorno integral, percentual parcial e janela sem estorno. | P0-A |
| 4 | Lista oficial de operações com auditoria obrigatória. | P0-B |
| 5 | Política de comunicação ao usuário quando a operação fica pendente de trilha. | P0-B |
| 6 | Múltiplas Persons para o mesmo usuário: bloquear ou exigir consolidação. | P1-A |
| 7 | Escopo de consultas de parceiro: por evento ou global. | P1-B |
| 8 | Campos mínimos por perfil em listas de participantes. | P1-B |
| 9 | `points_total` é contador derivado do ledger ou valor independente? | P1-C |
| 10 | Prazo e justificativa de retenção do histórico financeiro. | P2 |

## 12. Riscos residuais que este plano não cobre

- **Atomicidade entre entidades.** A plataforma não oferece transação multi-entidade; o plano mitiga com estados intermediários, bloqueio por trilha e reconciliação, mas não elimina a janela entre escritas.
- **Corrida entre revalidação de vínculo e execução.** A janela entre checar permissão e aplicar a alteração continua existindo; é reduzida por condicionais de estado, não zerada.
- **Webhook ausente.** Estornos e pagamentos reconciliados por varredura dependem do job rodar; atraso é possível mesmo com tudo correto.
- **Dados legados.** Registros criados antes das validações podem conter valores fora de faixa; a correção trata novas escritas, não reescreve histórico.
- **Fluxos não inspecionados.** Reviewer, curator, entrant e winner ainda precisam de revisão dedicada de leitura e escrita; a matriz de aceite os cobre por teste, não substitui a revisão de código.

## 13. Ordem de execução consolidada

1. **P0-A** — validação financeira. Aceite → libera P0-B.
2. **P0-B** — auditoria obrigatória bloqueante. Aceite → libera P1-A.
3. **P1-A** — identidade canônica. Aceite → libera P1-B e P1-C (podem correr em paralelo, entregas separadas).
4. **P1-B** — consultas e minimização.
5. **P1-C** — concorrência e idempotência.
6. **P2** — exclusão de conta e retenção.

Cada fase entrega: mudanças, testes automatizados do critério de aceite, resultado da matriz de perfis nos pontos afetados e registro das decisões tomadas na tabela do §11.