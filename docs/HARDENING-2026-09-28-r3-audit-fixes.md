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

## Verificação

- `vite build` OK (frontend).
- Boot-test pós-conversão OK: saveRaffle, manageParticipant, issueCertificate,
  manageConnection respondem 400/401 conforme esperado (parse e deploy OK).
- Varreduras: zero `Deno.serve` em funções, zero imports de SDK antigo,
  zero referências aos campos r1 removidos.