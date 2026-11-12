# Correção pré-migração — EventFinance (2026-11-12)

Escopo: **somente** `migrateEventFinance`. Nada de Fase 2/3, nada de ledger, correlação,
webhook, estornos, `EventFinance.jsonc` ou `Event.jsonc`.

## 1. Commits

- **Inicial:** `2c91880` (main, árvore limpa).
- **Final:** alterações em working tree, **não commitadas** (a plataforma commita na publicação;
  não criei commit manual).

## 2. Arquivos

| Arquivo | Situação |
|---|---|
| `base44/shared/eventFinanceMigration.ts` | **novo** — toda a lógica (cursor, ordem, confirmação, trilha) |
| `base44/functions/migrateEventFinance/entry.ts` | reescrito como wrapper fino (auth + payload + resposta) |
| `tests/unit/event-finance-migration.test.mjs` | **novo** — 15 testes |
| `tests/unit/lib/fakeEventDb.mjs` | **novo** — fake com cursor keyset (não toca no `fakeDb.mjs` dos estornos) |
| `package.json` | + script `test:unit:migration` |

Nenhuma entidade, nenhum fluxo financeiro e nenhum arquivo da Fase 1 foi tocado.

## 3. Correções

### 3.1 Paginação real
- `filter(query, { sort: 'created_date', limit, cursor })` → `{ items, next_cursor, has_more }`,
  recebendo `cursor` do payload e devolvendo `next_cursor`.
- **O filtro é fixo (todos os eventos), nunca "só o que precisa migrar".** Um conjunto que
  encolhe no meio da paginação faz o cursor pular registros; como `created_date` nunca é
  alterado, a ordem permanece estável entre páginas.
- **Nada de coleção inteira em memória** (lote padrão 200, máx 500).
- Falha em algum evento da página ⇒ **o cursor não avança**: `retry_page: true` e
  `next_cursor` = cursor de entrada. Reenviar relê a mesma página; migrados viram no-op.
- `eventId` preservado (modo `single`, sem paginação).
- Resposta: `ok, dry_run, mode, complete, scanned, created, merged, cleared_only,
  already_clean, failed, audit_failures, has_more, next_cursor, retry_page, cursor_used,
  failures[], details[]`.

### 3.2 Eventos excluídos logicamente
- A RLS de `Event` é `$or: [admin, status in (active, finished), manager_id = user.id]` —
  **sem condição de `is_deleted`**. Ou seja, evento excluído logicamente com status
  `active`/`finished` continua legível por qualquer usuário autenticado, com os campos
  financeiros. Logo, a migração passou a **incluir todos os eventos** (filtro `{}`).
- `is_deleted` é **preservado** (nunca reescrito) e nenhum evento ou documento financeiro é
  apagado. Exclusão lógica ≠ exclusão física.

### 3.3 Trilha obrigatória bloqueante
- `writeMandatoryAudit` **não é mais capturada com `continue`**. Se ela não confirmar, o evento
  fica com `stage: "audit"`, `ok: false`, e **o legado não é limpo**.
- Ordem: doc financeiro → **confirmação por leitura** → **trilha** → limpeza → **confirmação da
  limpeza**. A trilha vem antes da limpeza de propósito: se viesse depois, uma falha na limpeza
  deixaria o evento sem legado e sem trilha, e a reexecução encontraria "nada a migrar" e nunca
  gravaria a trilha.
- Confirmação positiva em cada etapa: escrita "otimista" que não persiste aborta antes da
  limpeza (teste 15).

| falhou em | estado após a falha | reexecução |
|---|---|---|
| criar/atualizar doc | EventFinance sem os valores; legado **intacto** | cria/completa e limpa |
| confirmar doc | idem | idem |
| gravar trilha | doc completo; legado **intacto** | trilha + limpeza |
| limpar legado | doc + trilha OK; legado ainda exposto | limpa (trilha é duplicada) |
| confirmar limpeza | idem | limpa/reconfirma |

## 4. Resultados dos testes

| Comando | Resultado |
|---|---|
| `npm run test:unit:migration` (novo) | **15/15 pass** |
| `npm run test:unit:refund` (Fase 1) | **115/115 pass** |
| `npm run test:unit:security` (Fase 2) | **9/9 pass** |
| `npm run build` | **exit 0** |
| `npx eslint` (migração + função) | **0 erros, 0 warnings** |

Cobertura pedida (item 4), teste por teste: 1 paginação multi-lote · 2 continuidade de cursor ·
3 reexecução sem duplicidade · 4 ativo · 5 finalizado · 6 excluído logicamente · 7 falha na
criação · 8 falha na atualização · 9 falha na limpeza · 10 falha no AuditLog · 11 recuperação
após falha parcial (com falha isolada no meio da página) · 12 valores existentes preservados ·
13 dry_run não escreve · 14 evento sem legado não gera documento · 15 escrita que não persiste
não autoriza limpeza.

## 5. Demonstração — paginação completa (dry-run real, produção)

Três chamadas da função real, `dry_run: true`:

| Chamada | scanned | created | clean | has_more | next_cursor | complete |
|---|---|---|---|---|---|---|
| 1 (limit 3) | 3 | 0 | 3 | true | token A | false |
| 2 (limit 3, cursor A) | 3 | 0 | 3 | true | token B | false |
| 3 (limit 10, cursor B) | 4 | 1 | 3 | **false** | **null** | **true** |

Total lido = **10 eventos** (a coleção inteira), sem sobreposição entre páginas:
página 1 → `…029cb, …ca3b, …ca3c`; página 2 → `…ca3d, …ca3e, …ca3f`; página 3 → `…ca40, …1dd0,
…cba5, …e23a`.

Resultado do dry-run completo: **9 eventos já limpos**, **1 evento a migrar**
(`E2E-REGRESSION-B`: `refund_policy` + `coupon_codes_registry`), **0 falhas**, 0 auditorias.
Verificação pós-dry-run: `EventFinance` = **0 documentos**, trilhas `event_finance_migrado|*` =
**0**, e o evento legado **continua com os campos** (nada foi escrito).

Teste unitário equivalente: 7 eventos em lotes de 3 → 3+3+1, 7 documentos, 7 trilhas, sem
duplicidade e sem omissão (testes 1 e 2).

## 6. Demonstração — recuperação de falha parcial

1. **Criação indisponível** (teste 7): `ok:false`, `stage:finance_create`, legado intacto,
   nenhuma trilha, `retry_page:true`.
2. **Trilha indisponível** (teste 10): documento financeiro **gravado** (dado preservado), legado
   **intacto**, nenhuma trilha, `audit_failures:2`. Ao voltar a trilha, a reexecução grava a
   trilha e **só então** limpa; `created:0` (documento não recriado), 2 trilhas no total.
3. **Limpeza do legado indisponível** (teste 9): documento + trilha já gravados; legado ainda
   exposto; `stage:legacy_clear`. Reexecução: `created:0`, `cleared_only:1`, **1** documento,
   **1** trilha (sem duplicar), legado limpo.
4. **Falha isolada no meio da página** (teste 11): `limit:2`, `ev_002` falha. `retry_page:true`,
   `next_cursor:null` (cursor de entrada). Reenviar o cursor: `already_clean:1` (não reprocessa),
   `created:1` (só o que faltava), 2 trilhas (uma por evento), e a página seguinte é alcançada.

## 7. Confirmações

- **`dry_run: false` NUNCA foi executado.** Nenhuma chamada com esse payload; evidência:
  0 documentos `EventFinance`, 0 trilhas de migração, campos legados intactos.
- **Nenhum deploy.** Nenhum commit manual.
- **Nenhum dado de produção alterado** (os três dry-runs são somente leitura, por construção: o
  caminho de escrita só existe quando `dryRun === false`).
- Nenhum arquivo do ledger, correlação, webhook ou estorno da Fase 1 foi modificado.

## 8. Riscos residuais

1. **A exposição continua** enquanto a migração não rodar: hoje **1 evento ativo** expõe
   `refund_policy` e 2 códigos de cupom a qualquer usuário autenticado.
2. **Concorrência entre dois admins**: não existe unicidade por `event_id` em `EventFinance`.
   Duas execuções simultâneas sobre o mesmo evento podem criar dois documentos. Rode uma única
   execução por vez (o cursor sequencial já é naturalmente serial). Não assumi atomicidade nem
   testei concorrência real.
3. **Contrato do cursor do SDK**: o token é opaco. O teste unitário usa cursor keyset próprio e o
   dry-run real confirmou continuidade entre páginas, mas uma mudança futura do SDK só apareceria
   em um novo dry-run — repita o dry-run completo antes da execução real.
4. **Custo por evento**: 4 leituras + 2 escritas (confirmar doc, confirmar limpeza, trilha com
   sua própria releitura). Em bases grandes, use lotes menores e várias execuções.
5. **Trilha sem valores**: o `AuditLog` registra nomes de campos e flags, não os valores
   financeiros — de propósito (não duplicar dado sensível em log).

## 9. Como autorizar a execução real (quando decidir)

1. Dry-run completo, iterando o cursor até `complete: true` → confira `failures: []`.
2. `{ "dry_run": false, "limit": 100 }` e repita com `next_cursor` até `complete: true`.
3. Se vier `retry_page: true`, reenvie o mesmo `next_cursor` — nada foi pulado.
