# Hardening r3 — Correções da auditoria full (2026-09-28)

Implementação dos achados P0/P1/P3 da auditoria completa de 2026-09-28
(audit focada em segurança, integridade, acesso, performance, duplicação,
regras de negócio e higiene). P2 permanece no backlog (truncagens
silenciosas, campanhas agendadas como estado morto, contador redeemed_total
em cancelamento manual, timeout de dispatch global).

## P0 — Campanhas: "Enviar Agora" rejeitado pela trava de dispatch

- `CampaignForm.jsx` gravava a campanha com status `processing` ANTES de
  invocar `dispatchNotificationCampaign`; o claim CAS do dispatch só assume
  `draft/scheduled/partially_sent/failed` → 409 "Envio já em andamento".
  Corrigido: o "Enviar Agora" agora grava `draft` e a trava faz a transição
  draft→processing (exatamente um dispatcher).
- Evidência: única campanha `sent` na base é anterior ao endurecimento; as
  4 posteriores estavam travadas em `draft`.

## P1-1 — saveRaffle: gate alinhado ao executeRaffle

- `canAccessEventData` (nível participante) → `verifyEventMembership` com
  `EVENT_MANAGER_ROLES` (manager/team do PRÓPRIO evento ou admin). Antes,
  qualquer participante podia gravar sorteios do evento via API.

## P1-2 — manageParticipant/findPersonsByDocument: PERF-002 real + PII cross-event

- PERF-002 NÃO era falso positivo: a busca carregava TODOS os
  PersonDocuments ativos do sistema (full scan global + substring in-memory)
  e devolvia person_ids de pessoas de QUALQUER evento a qualquer gerente.
- Corrigido: escopo do PRÓPRIO evento (padrão INF-002) — a busca cobre apenas
  Persons vinculadas a participantes do evento autorizado, com `$in`
  fatiado por 500.
- MUDANÇA DE COMPORTAMENTO deliberada: Persons de outros eventos não são
  mais encontráveis por dígito de documento por gerentes de evento (a
  deduplicação de mesmo-CPF continua válida DENTRO do evento).

## P3 — Higiene e padronização

- **Padrão de sobrevivente determinístico consolidado**: novo módulo
  `base44/shared/deterministicSurvivor.ts` (`deterministicCompare` —
  ordenação estável por (created_date, id)). Aplicado nos 7 sítios:
  redeemStoreItem ×2, processScoringAction ×2, issueCertificate,
  getOrCreateThread (que nem tinha tiebreaker por id — corrida possível),
  createPaymentIntent ×2 (cupons e checkout concorrente).
- **Padronização de handlers**: TODAS as 30 funções `Deno.serve` migradas
  para o padrão oficial `export default async function(req)`; versão do SDK
  unificada em `npm:@base44/sdk@0.8.52` (antes: mistura 0.8.38/0.8.40/0.8.44
  — 82 imports agora uniformes).
- **Campos legados removidos do schema da Person**: `checkout_lock_event_id`,
  `checkout_lock_order_id`, `checkout_lock_expires_at` (lock r1 — nenhum
  código os lia/escrevia desde r2; valores antigos permanecem apenas no
  banco). `Ticket.pdf_url` MANTIDO: ingressos legados ainda o usam.
- **issueCertificate**: colisão de hash após 5 tentativas agora é erro
  explícito (antes gravava o último hash sem checagem final).
- **manageParticipant/importUpdate**: update de importação envia apenas as
  chaves presentes (antes podia zerar contadores em updates parciais).

## P2 — Lote aprovado em 2026-09-28 (item 3, agendamento, segue on hold)

- **Fim da truncagem silenciosa nas listas grandes (PERF)**: participante e
  certificados agora carregam TODAS as páginas encadeadas —
  `fetchAllEventParticipants` (lotes de 2.000 via getEventParticipants com
  limit/skip) nas telas de Pessoas (gestão + módulo) e no emissor de
  certificados; `scanAllRecords` (src/lib/fetchAll.js) para o histórico de
  certificados. O histórico ganhou "Mostrar mais" (+30) — antes exibia só os
  30 primeiros sem aviso. Total exibido passa a refletir o conjunto real.
- **Disparo de campanhas grandes resumível**: dispatchNotificationCampaign
  ganhou orçamento de tempo por invocação (15s). Orçamento estourado na
  RESOLUÇÃO → status 'failed' (reassumível; dedup por $in torna a
  re-resolução idempotente). Estourado na ENTREGA → 'partially_sent'; a
  retomada PULA a fase 1 (recipients já existem) e só entrega — sem custo de
  re-resolver a audiência a cada rodada. Erro inesperado pós-claim reverte
  para 'failed' — campanha nunca mais fica presa em 'processing'. O service
  do frontend encadeia rodadas (has_more) até esgotar a fila (máx. 30).
- **Contadores de pontos/resgates (drift por cancelamento fora do fluxo)**:
  o reconciler admin-only reconcileParticipantCounters (ledger como fonte da
  verdade) ganhou acesso na UI — card "Pontos e resgates" na aba Loja (admin):
  verificação em dry-run com resumo do drift e aplicação da correção.
- Segredo legado `SCHEDULER_INTERNAL_TOKEN` removido manualmente pelo usuário.

## Higiene de código — Lote 2026-09-29 (revisão: regras de negócio, código morto, duplicação, performance)

**P0 (corrigido) — cursor `id` no completeScan truncava tudo silenciosamente.**
Range query `$lt` no campo `id` não funciona no SDK (retorna 0 registros —
validado na base). scanBatches/scanAll usados por TODAS as funções de
reconciliação, métricas, expiração e exclusão de conta paravam na 1ª página
sem erro. Reescrito em **skip-based** (skip+limit determinístico, stop em
página curta). Migração obrigatória (id-cursor não é suportado).

**P2 — Fim da duplicação entre funções backend (helpers shared):**
- `completeScan.ts` (scanBatches/scanAll/fetchPage/countAll) substituiu os
  ~7 loops de paginação manuais (reconcilers de métricas/participantes,
  deleteMyAccount, disparo de campanhas, getEventOrders).
- `sanitize.ts` (sanitizeText + sanitizeAllowlisted/sanitizeData) unificou
  5 cópias de sanitizeText e 2 de sanitizeData com drift entre si.
- `participantOwnership.ts`, `personPair.ts`, `partnerPublicView.ts`
  (drift de shape entre as 2 cópias corrigido), `deterministicSurvivor.ts`
  (tie-break created_date+id em toda deduplicação), `dayKey.ts`.
- `paymentSanitizer` fundido em getEventOrders (consumidor único).

**P3 — Código morto removido (19 exports, 3 arquivos):**
- `lib/roleEngine.js` (arquivo) → getMyMemberships consolidado em `access.js`.
- `src/utils/index.ts` (arquivo, test seed): getStageCredentials e derivados.
- `base44/shared/paymentSanitizer.ts` (arquivo).
- access.js: canManageEvent (contraditório), isRepresentative.
- businessUtils.js: 6 exports mortos (período vive em businessPeriod.ts).
- businessCounters.js: incLeads/incPersons (mantidos server-side).
- personApi: listPartnerPersons; redeemService: sortPersonIds duplicado;
  awardUtils: criteriaMaxTotal; utils: isIframe; apiClient: withTimeout;
  profileCompleteness: COMPLETENESS_FIELDS; salesExport: buildSalesCsv;
  participantApi/commerceApi: fetchPage duplicado.
- Frontend: loops de paginação manuais de fetchAllEventParticipants/
  fetchAllMyEventsParticipants unificados via scanPagedEndpoint.

**Pendências abertas (P0/P1/P3 de UI):**
- P0: acesso SDK direto a entidades travadas em redeService,
  SessionRankingSection e AudienceSelector.
- P1: consolidar access.js vs useEventAccess.
- P3: componentizar PessoasTab, ConquistasTab e SessionDetail.

## Verificação

- `vite build` OK (frontend).
- Boot-test pós-conversão OK: saveRaffle, manageParticipant, issueCertificate,
  manageConnection respondem 400/401 conforme esperado (parse e deploy OK).
- Boot-test 2026-09-29 OK: getEventOrders responde 400 ("eventId obrigatório")
  após fusão do paymentSanitizer — parse e deploy OK.
- Varreduras: zero `Deno.serve` em funções, zero imports de SDK antigo,
  zero referências aos campos r1 removidos, zero imports dos módulos removidos
  (roleEngine, paymentSanitizer, utils/index), zero while(true) não intencional.