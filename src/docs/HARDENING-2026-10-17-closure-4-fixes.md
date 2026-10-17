# Fechamento pós-auditoria — 4 correções (2026-10-17)

Modo: implementação controlada + testes reais. Sem deploy/publicação; sem
escritas em dados de produção (função de teste temporária criada e excluída).

## 1. Campanhas agendadas — Implementado (mínimo)

`base44/functions/manageNotificationCampaign/entry.ts` (caminho de update):
- `contentChanged` (title/message/type/priority/cta_label/cta_target) +
  `wasScheduled` (scheduled_at presente e status ≠ draft).
- Conteúdo editado em campanha agendada → `auto_dispatch_attempts` RESETADO
  (nova janela de aprovação) + AuditLog `scheduled_campaign_edited`.
- Regra definida: audiência/escopo/emissor continuam IMUTÁVEIS (recusados);
  a revalidação de autorização no update (verdict) e no disparo agendado
  (sweep) já existia e foi preservada.

Testes: op inválida → 400 (real). Escrita do caminho de update NÃO executada
(exigiria escrita em Produção) — validado por revisão estática da lógica.

## 2. PDF/SSRF — Implementado (mínimo)

`base44/shared/safeImageFetch.ts`:
- `isPrivateIpLiteral` exportado (mesma régua v4/v6 para hostnames literais e
  endereços RESOLVIDOS).
- `dnsCheck`: resolve A + AAAA via `Deno.resolveDns` e bloqueia se qualquer IP
  final for privado/reservado (`dns_private_ip`), se não resolver
  (`dns_unresolved`) ou se a verificação falhar (`dns_check_failed`) —
  fail-closed. Runtime inclui CNAMEs na resposta de 'A' (descoberto no teste):
  só registros IP-literal são avaliados; IPs finais acompanham a cadeia.

`base44/shared/ticketPdf.ts`:
- `fetchImagePool` com orçamento TOTAL: 6 MB acumulados e 15 s — imagens além
  do orçamento não são buscadas; pool de 4 mantém a concorrência limitada.
- `buildTicketPdfExtras`: teto de 20 vínculos EventPartner / 20 Partner por
  geração.

`base44/functions/getTicketPdf/entry.ts`:
- Poda do mapa de rate limit (>500 chaves descarta as 100 mais antigas — o
  isolate não cresce sem limite).

Testes REAIS (runtime Deno, via função temporária zzProbeSecurity, excluída):
- isPrivateIpLiteral: 13/13 casos (loopback, privados v4, CGNAT, link-local,
  ULA, IPv6 público negativo).
- fetchSafeImage: localtest.me (DNS→127.0.0.1) → dns_private_ip; 127-0-0-1.nip.io
  → dns_private_ip; host inexistente → dns_unresolved; http:// → scheme_not_https;
  localhost/127.0.0.1/169.254.169.254/[::1] → blocked_host.
- Deno.resolveDns disponível e validado.
- Limitação: controle positivo de download — o egress do runtime retorna
  fetch_failed para URL externa qualquer (também ocorreria no código anterior);
  MIME/assinatura/streaming/timeout não foram exercitados ao vivo (sem
  servidor de controle). Redirecionamento: bloqueado por `redirect:'error'`
  (análise estática).

## 3. getMyLeads — Preservado + ajuste mínimo

`base44/functions/getMyLeads/entry.ts`: cursor inválido agora → 400
("Cursor inválido.") em vez de 500.

Testes REAIS (executor autenticado como admin):
- {} → 400 partnerId obrigatório (guard + validação).
- limit 5000 → normalizado server-side (resposta ≤ MAX_LIMIT; com 1 lead real,
  o teto de 200 é verificação estática — Math.min).
- cursor inválido → 400 (após o ajuste).
- Minimização de PII confirmada: resposta contém exatamente LEAD_FIELDS (sem
  phone/linkedin/company/job_title).
- Limitação: autorização não-admin (rep de parceiro) não exercível — o
  executor roda como admin (bypass explicado em canAccessPartnerData);
  continuidade de cursor (has_more=true) não exercível — só 1 lead por
  parceiro em Produção (criar leads de teste = escrita em produção, proibida).

## 4. SDK Base44 — Verificado, sem mudança

- package.json + package-lock.json: `@base44/sdk ^0.8.54`.
- 85/85 funções backend importam `npm:@base44/sdk@0.8.54`; nenhuma referência
  a 0.8.52.
- `npx vite build` → exit 0.
- Execução real confirmou compatibilidade do SDK 0.8.54 no runtime (testes
  das funções acima com createClientFromRequest/requireActiveUser/filter/
  count).

## Riscos residuais

- Janela TOCTOU mínima entre resolução DNS e fetch (mitigada: HTTPS,
  redirect 'error', assinatura de imagem) — padrão da indústria.
- Egress do runtime pode limitar fetch de imagens externas (fetch_failed) —
  falha de imagem nunca impede o PDF (comportamento preservado).
- Rate limit continua em memória por isolate (best-effort, agora podado);
  proteção de custo real permanece: autenticação + 429 + autorização.
- Item 1: revalidação no disparo já cobre o caso; a nova regra (reset de
  tentativas + auditoria) aguarda validação funcional.

Pronto para revisão/publicação — nada foi publicado nesta etapa.