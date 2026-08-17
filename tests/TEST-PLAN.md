# Evolve Summit — QA Automation Test Plan

## 1. Método

**BDD + Risk-Based Testing + Test Pyramid.**

- **BDD/Gherkin** para cenários funcionais e critérios de aceite legíveis pelo negócio.
- **Risk-based** para priorizar primeiro permissões, dados, gamificação, bulk import e isolamento entre eventos.
- **E2E** para fluxos críticos de cada persona.
- **API/contract tests** para regras que não devem depender de UI.
- **Smoke/regression suites** para execução frequente.

### Prioridade de personas
1. Gerente
2. Staff
3. Participante
4. Palestrante
5. Parceiro

### Severidade
- **P0:** perda/corrupção de dados, bypass de autorização, operação financeira/gamificação incorreta, exclusão indevida.
- **P1:** função crítica indisponível ou resultado incorreto sem workaround aceitável.
- **P2:** regressão funcional de impacto moderado.
- **P3:** UX/copy/polish.

## 2. Ambientes

- Base alvo padrão: `https://share--evolve-summit.base44.app`
- A suíte **não usa produção**.
- Recomendado: um evento dedicado `E2E-REGRESSION` e cinco contas de teste estáveis.
- Contas são configuradas por variáveis de ambiente; nenhum segredo fica no repositório.

## 3. Dados mínimos necessários

Variáveis:

```text
E2E_BASE_URL
E2E_MANAGER_EMAIL / E2E_MANAGER_PASSWORD
E2E_STAFF_EMAIL / E2E_STAFF_PASSWORD
E2E_PARTICIPANT_EMAIL / E2E_PARTICIPANT_PASSWORD
E2E_SPEAKER_EMAIL / E2E_SPEAKER_PASSWORD
E2E_PARTNER_EMAIL / E2E_PARTNER_PASSWORD
E2E_EVENT_ID
E2E_SPEAKER_EVENT_ID (opcional)
E2E_PARTNER_EVENT_ID (opcional)
```

O usuário de teste deve ter a role correspondente em `EventMembership`/`Participant`, conforme o modelo real do app.

## 4. Matriz de cobertura

| Domínio | Gerente | Staff | Participante | Palestrante | Parceiro |
|---|---:|---:|---:|---:|---:|
| Login/logout | P0 | P0 | P0 | P0 | P0 |
| Acesso por evento | P0 | P0 | P0 | P0 | P0 |
| Dashboard | P0 | P1 | P1 | P1 | P0 |
| Pessoas/participantes | P0 | P0 | P1 | P2 | P1 |
| Bulk CSV | P0 | P1 | — | — | — |
| Programação | P1 | P1 | P0 | P0 | P1 |
| Gamificação | P0 | P0 | P0 | P1 | P1 |
| Loja/resgate | P0 | P1 | P0 | P1 | P1 |
| Ranking | P0 | P0 | P0 | P0 | P1 |
| Networking | P1 | P1 | P0 | P0 | P1 |
| Notificações | P0 | P0 | P0 | P1 | P0 |
| CFP/premiação | P0 | P1 | P1 | P0 | — |
| Certificados | P0 | P1 | P1 | P1 | — |
| Leads | P0 | P1 | — | P1 | P0 |
| Sorteio | P0 | P1 | — | P1 | P0 |
| Exclusão de conta | P1 | P1 | P0 | P1 | P1 |
| Segurança cross-event | P0 | P0 | P0 | P0 | P0 |

## 5. Suites

### Smoke — cada deploy
- autenticação;
- home;
- evento;
- programação;
- perfil;
- permissões básicas;
- uma mutation representativa por persona.

### Regression — diária/antes de release
- todos os P0/P1 acima;
- networking;
- notificações;
- ranking/gamificação;
- loja;
- certificados;
- bulk import;
- mobile.

### Security — antes de release e após mudança de backend
- IDOR;
- cross-event;
- role escalation;
- deleted-account guard;
- ownership de connection/scoring/store;
- autorização de campanhas.

### Bulk/scale
- CSV válido pequeno;
- CSV com duplicatas;
- CSV com inválidos;
- registros existentes fora do evento;
- registros já vinculados;
- 500+ linhas;
- 1000+ linhas;
- repetição do mesmo arquivo;
- arquivo com linhas parcialmente inválidas.

## 6. Critério de aprovação

Release candidato somente se:

- nenhum P0 falhar;
- nenhum P1 novo estiver aberto sem aceite explícito;
- smoke 100% verde;
- security suite 100% verde;
- bulk suite verde para os cenários suportados;
- falhas conhecidas estiverem registradas em `tests/KNOWN-ISSUES.md`.

## 7. Evidências

Cada falha deve guardar automaticamente:

- cenário;
- persona;
- URL;
- passo que falhou;
- expected;
- actual;
- screenshot;
- trace;
- vídeo quando habilitado;
- timestamp;
- build/commit quando disponível.

## 8. Regra de ouro

Os testes devem verificar **resultado**, não implementação.

Exemplo ruim:
`expect(queryKey).toContain('event_id')`

Exemplo bom:
`um gerente do Evento A não consegue acessar dados privados do Evento B.`
