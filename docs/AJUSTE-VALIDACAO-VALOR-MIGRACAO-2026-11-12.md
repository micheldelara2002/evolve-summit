# Ajuste final — validação exata de valor na migração EventFinance (2026-11-12)

Escopo: **apenas** `confirmFinancePersisted()` (`base44/shared/eventFinanceMigration.ts`) e
seus testes. Nenhuma entidade, RLS, regra de negócio, fluxo de pagamento ou arquivo da Fase 1
foi tocado.

## 1. Arquivos alterados

```
 M base44/shared/eventFinanceMigration.ts      | 148 ++++++++++++++++++++--
 M tests/unit/event-finance-migration.test.mjs | 190 +++++++++++++++++++++++++++-
 2 files changed, 328 insertions(+), 10 deletions(-)
```

Nada além destes dois arquivos (`git status` limpo no restante).

## 2. Diff (produção)

```diff
@@ -12,7 +12,8 @@
-//   3. CONFIRMAR por leitura que os valores estão gravados;
+//   3. CONFIRMAR por leitura que os valores gravados são EXATAMENTE os esperados
+//      (comparação de valor, não de presença — ver `confirmFinancePersisted`);

@@ async function confirmFinancePersisted(
   svc: any,
   eventId: string,
   expected: Record<string, any>,
+  preserved: Record<string, any> = {},
 ): Promise<{ ok: boolean; reason?: string; financeId?: string }> {
...
-  const missing = Object.keys(expected).filter((field) => !hasValue(doc[field]));
-  if (missing.length > 0) {
-    return {
-      ok: false,
-      reason: `Campos não persistidos em EventFinance: ${missing.join(", ")} — nada foi limpo no evento.`,
-    };
+  // (a) O que a migração escreveu precisa estar gravado com o MESMO valor.
+  for (const field of Object.keys(expected)) {
+    if (!valuesEquivalent(expected[field], doc[field])) {
+      return {
+        ok: false,
+        reason: `Campo ${field} divergente em EventFinance: ${divergenceDetail(expected[field], doc[field])} — nada foi limpo no evento.`,
+      };
+    }
+  }
+  // (b) Valor já configurado continua sendo a fonte da verdade: a escrita não pode
+  // tê-lo alterado (documento substituído em vez de completado, por exemplo).
+  for (const field of Object.keys(preserved)) {
+    if (!valuesEquivalent(preserved[field], doc[field])) {
+      return {
+        ok: false,
+        reason: `Campo ${field} já configurado em EventFinance foi alterado pela escrita: esperado manter ${describeValue(preserved[field])}, persistido ${describeValue(doc[field])} — nada foi limpo no evento.`,
+      };
+    }
   }
   return { ok: true, financeId: doc.id };
 }
@@ migrateOne
   let expected: Record<string, any> = {};
+  let preserved: Record<string, any> = {};
...
   } else if (patchFields.length > 0) {
     expected = patch;
+    preserved = configuredValues(existing, patchFields);
...
-    const confirmed = await confirmFinancePersisted(svc, event.id, expected);
+    const confirmed = await confirmFinancePersisted(svc, event.id, expected, preserved);
```

Novos auxiliares (mesmo arquivo): `describeValue`, `parseJsonText`, `canonicalize`, `deepEqual`,
`valuesEquivalent`, `divergenceDetail`, `configuredValues`.

## 3. Regra de equivalência aplicada

| Tipo | Regra |
|---|---|
| número | valor numérico exato; **`0` é valor** (não ausência) |
| array | mesmo tamanho, mesmo conteúdo **e mesma ordem**, elemento por elemento |
| objeto | mesmas chaves, mesmos valores (ordem de chave não é conteúdo) |
| texto | igual; ou dois textos JSON com o mesmo conteúdo semântico (`refund_policy`) |
| misto | tipo diferente é divergência (`10` ≠ `"10"`, `0` ≠ `""`, valor ≠ ausente) |

`ok: false` nomeia o campo e o motivo (`esperado …, persistido …`; em arrays, o índice divergente).
Nesse caminho o fluxo retorna em `finance_confirm`: **a trilha de sucesso não é gravada e nenhum
campo legado do Event é limpo**.

Valor já configurado em `EventFinance` continua sendo a fonte da verdade: o patch só preenche
campos vazios (inalterado) e, agora, a confirmação também verifica que a escrita **não alterou**
esses valores preservados.

## 4. Testes executados

| Comando | Resultado |
|---|---|
| `npm run test:unit:migration` | **25/25 pass** (eram 15; +10) |
| `npm run test:unit:refund` (Fase 1) | **115/115 pass** |
| `npm run test:unit:security` (Fase 2) | **9/9 pass** |
| `npm run build` | **exit 0** |
| `npx eslint base44/shared/eventFinanceMigration.ts base44/functions/migrateEventFinance/entry.ts` | **0 erros, 0 warnings** |

Cobertura dos 8 testes obrigatórios:

| Obrigatório | Teste |
|---|---|
| Valores idênticos: aprovada | 16 |
| Comissão diferente: bloqueada | 17 |
| `payout_account_id` diferente: bloqueada | 18 |
| `refund_policy` diferente: bloqueada (merge) | 19 |
| `coupon_codes_registry` diferente: bloqueada (ordem) | 20 |
| `coupon_codes_registry` diferente: bloqueada (item a mais) | 21 |
| Valor numérico zero: aceito quando esperado | 22 |
| Zero esperado × ausente: bloqueado | 23 |
| Falha de confirmação: legado intacto, sem trilha | 17–21, 24 |
| Reexecução após corrigir a divergência: sem duplicidade | 25 |
| Valor já configurado não pode ser alterado pela escrita | 24 |

Os testes 1–15 (paginação, exclusão lógica, falhas parciais, trilha bloqueante, dry-run)
continuam passando sem alteração de expectativa.

## 5. Confirmação explícita

- **Nenhuma migração real foi executada.** Nenhuma chamada a `migrateEventFinance` neste
  ajuste, em nenhum modo — nem dry-run, nem `dry_run: false`.
- **Nenhum dado de produção foi alterado** (leitura/escrita de entidades não foi usada; só
  testes unitários contra um banco fake em memória).
- **Nenhum deploy, nenhuma publicação, nenhum commit manual.**
- `EventFinance.jsonc`, `Event.jsonc`, RLS e a Fase 1 (ledger, correlação, webhook, estornos)
  permanecem exatamente como estavam.

## 6. Riscos residuais

1. **Equivalência semântica de JSON**: dois textos JSON com o mesmo conteúdo, porém formatados
   de forma diferente, são aceitos como equivalentes. Se a exigência for identidade byte a byte,
   basta remover o fallback de `valuesEquivalent`.
2. **Escopo da comparação**: só os campos financeiros escritos/preservados são comparados;
   campos de sistema (`updated_date` etc.) não entram.
3. **Concorrência real** não é exercitada: o fake serializa tudo. Duas execuções simultâneas
   sobre o mesmo evento continuam fora do alcance dos testes (e sem unicidade por `event_id`).
4. A comparação detecta divergência, mas **não corrige**: a resolução é do operador (ajustar o
   documento pelo caminho normal de gestão e reexecutar — cenário do teste 25).
