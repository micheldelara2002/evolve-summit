# Evolve Summit — Autonomous QA Framework

Framework criado para regressão recorrente do app, com prioridade:

1. Gerente
2. Staff
3. Participante
4. Palestrante
5. Parceiro

## Stack

- Playwright Test
- BDD/Gherkin para especificação
- Risk-based prioritization
- E2E por persona
- Suites separadas para smoke, security, bulk e mobile

## Primeira configuração

O projeto já contém a configuração do Playwright e os scripts npm. No ambiente onde os testes serão executados, instale as dependências:

```bash
npm install
npx playwright install chromium
```

Configure as variáveis:

```bash
export E2E_BASE_URL="https://share--evolve-summit.base44.app"
export E2E_EVENT_ID="<evento-de-regressao>"
export E2E_MANAGER_EMAIL="..."
export E2E_MANAGER_PASSWORD="..."
export E2E_STAFF_EMAIL="..."
export E2E_STAFF_PASSWORD="..."
export E2E_PARTICIPANT_EMAIL="..."
export E2E_PARTICIPANT_PASSWORD="..."
export E2E_SPEAKER_EMAIL="..."
export E2E_SPEAKER_PASSWORD="..."
export E2E_PARTNER_EMAIL="..."
export E2E_PARTNER_PASSWORD="..."
```

As contas devem existir na **base de testes**, nunca na produção.

## Execução

```bash
npm run test:e2e
```

Smoke:

```bash
npm run test:e2e:smoke
```

Regression:

```bash
npm run test:e2e:regression
```

Security:

```bash
npm run test:e2e:security
```

Bulk:

```bash
npm run test:e2e:bulk
```

Mobile:

```bash
npm run test:e2e:mobile
```

Relatório HTML:

```bash
npx playwright show-report test-results/html
```

## Filosofia de execução

A suíte deve ser **read-mostly por padrão**. Testes destrutivos ou que criam dados devem usar um evento explicitamente dedicado à regressão.

O primeiro pacote de bulk import testa o dry-run e cenários de validação sem confirmar a importação. Os cenários de confirmação, concorrência e limpeza ficam classificados como testes de integração/scale e devem usar dados descartáveis.

## Contas de teste

Recomendação:

- `qa-manager@...`
- `qa-staff@...`
- `qa-participant@...`
- `qa-speaker@...`
- `qa-partner@...`

O mesmo usuário não deve ser reutilizado entre personas, porque isso mascara falhas de autorização.

## Evidências

Em falha, Playwright mantém screenshot/trace/vídeo conforme configuração. O JSON em `test-results/results.json` permite integração futura com CI/CD.

## Estado atual da suíte

A suíte foi expandida para cobrir os cinco papéis prioritários, segurança E2E, bulk preview/scale, mobile regression, smoke e regression. A lista executável deve ser verificada com:

```bash
npm run test:e2e -- --list
```

A quantidade de testes listados é evidência de inventário, não de aprovação. Para aprovação, executar a suíte no ambiente de teste com as credenciais e `E2E_EVENT_ID` configurados.

## Próxima evolução

Depois de estabilizar o E2E, adicionar uma segunda camada de testes de contrato para as backend functions críticas:

- `processScoringAction`
- `redeemStoreItem`
- `manageConnection`
- `dispatchNotificationCampaign`
- `deleteMyAccount`
- `issueCertificate`
- `manageSubmission`
- `manageAward`

Essa camada deve testar diretamente autorização, idempotência, cross-event e invariantes de dados, sem depender de elementos da UI.
