# Relatório de implementação — P2 Bloco A

**Projeto:** Evolve Summit (plataforma de gestão de eventos)
**Data:** 2026-11-22
**Escopo:** integridade transacional e de dados — seis defeitos corrigidos
**Status:** implementado, testado e em produção (build limpo, 86 testes novos verdes, regressão integral verde)

---

## 1. Contexto

Aplicação web (React + Vite) sobre um backend BaaS ("Base44") com banco de documentos. O módulo financeiro cobre venda de ingressos (Stripe), estoque por lote, cupons, estornos, emissão de ingressos/participantes e repasse aos organizadores (Stripe Connect). Há também premiação com banca avaliadora e um modelo de identidade global de pessoas (LGPD).

## 2. Restrições da plataforma (relevantes para avaliar as escolhas)

Estas restrições explicam por que cada garantia foi implementada de uma forma específica:

1. **Não existe transação entre documentos.** A única escrita atômica disponível é **por documento** (`updateMany(query, update)` com filtro condicional = compare-and-swap).
2. **Não há índice único** criável pela aplicação; unicidade lógica é obtida por CAS + convergência determinística.
3. **Escrita de dados sensíveis é feita por backend functions em service role**; o cliente não escreve diretamente em entidades financeiras (RLS admin-only).
4. **Chamadas ao provedor de pagamento são externas** ao banco: não há atomicidade entre "gravou" e "cobrou". Por isso a regra adotada é *trilha antes do efeito externo* e *confirmação por leitura* depois.
5. Regra transversal do projeto: **nunca declarar sucesso sem prova**. Falha de leitura é tratada como estado indeterminado (fail-closed), nunca como ausência.

## 3. Itens implementados

### P2-01 — Ciclo de vida durável da reserva de cupom

**Defeito:** o checkout incrementava `Coupon.uses_count` **antes** de criar o pedido. Se qualquer passo seguinte falhasse, o uso ficava consumido sem pedido correspondente — cupom esgotado artificialmente, sem origem rastreável.

**Correção:** nova entidade `CouponReservation` (admin-only, escrita só por backend) + `shared/couponReservation.ts`.
- Cada tentativa de checkout gera **um** registro identificado por `checkout_token` gerado no servidor.
- Estados terminais: `reserved` → `committed` (venda confirmada, uso permanece) ou `released` (uso devolvido).
- Liberação = **CAS no próprio registro** (`reserved → released`): exatamente uma execução devolve o uso, repetir é no-op, nenhuma requisição libera reserva de outra.
- Marcadores `counter_reserved` / `counter_decremented` separam quem consumiu de quem devolveu. Quando o marcador do pedido (`coupon_uses_counted`) já devolveu o uso, a reserva registra o desfecho com `counterHandledBy: "order"` e **não** decrementa de novo.
- Cupom ilimitado (`max_uses = 0`) registra reserva sem consumir teto.
- Reconciliação no job agendado classifica cada reserva (`sem_pedido`, `pagamento_confirmado`, `processando`, `indeterminado`, `ativo_no_provedor`, `pedido_encerrado`, `pedido_vivo`, `leitura_indisponivel`) e **nunca devolve uso sem prova de ausência de pagamento**.

**Invariante:** não existe uso consumido sem registro que o explique; não existe caminho que devolva o mesmo uso duas vezes.

---

### P2-02 — Assinatura do webhook Stripe com múltiplas `v1`

**Defeito:** o parser guardava apenas a **última** ocorrência de `v1` no header. Em rotação de segredo (ou qualquer header em que a assinatura válida não fosse a última), um webhook **legítimo** era recusado com 400 e o pagamento só era reconciliado pelo polling.

**Correção:** `shared/stripeSignature.ts`.
- `parseStripeSignature` preserva **todas** as `v1` e ignora esquemas desconhecidos.
- `verifyStripeSignature` aceita **um segredo ou uma lista** (novo + anterior) e casa qualquer par (segredo, `v1`).
- Verificação sobre os **bytes originais** do corpo (nada é reserializado), janela de tolerância de 300 s, comparação em tempo constante, falha fechada quando não há segredo configurado.
- Motivos de recusa distintos para diagnóstico: `header_malformado`, `assinatura_ausente`, `sem_assinatura_v1`, `timestamp_invalido`, `timestamp_conflitante`, `timestamp_fora_da_janela`, `assinatura_invalida`, `segredo_ausente`.

**Invariante:** rotação de segredo não derruba entrega; payload adulterado continua recusado.

---

### P2-03 — Estados da identidade (LGPD) na resolução de Person

**Defeito:** a busca por e-mail filtrava `is_active: { $ne: false }`, então cadastros **inativos** nunca apareciam — e o ramo que deveria reativá-los era código morto. Quem tinha cadastro desativado ganhava uma **segunda** Person ao comprar de novo, dividindo pontos, certificados e histórico. Além disso, nada impedia reativar uma Person **anonimizada**, desfazendo uma exclusão LGPD.

**Correção:** `shared/personResolution.ts` com três estados explícitos:
- **ativa** → reutilizada;
- **inativa** → **reativada por CAS** (`is_active: false` e `is_anonymized ≠ true` → `true`) com trilha `person_reactivated` (ator, evento, motivo);
- **anonimizada** → nunca reutilizada nem reativada: quem volta recebe identidade **nova**; o registro anonimizado permanece intocado;
- falha de leitura é **recusa** (`lookup_unavailable`), nunca criação de duplicata;
- corrida de criação converge para o sobrevivente determinístico `(created_date, id)`; o excedente é **desativado** (nunca apagado) com trilha `person_duplicate_converged`;
- CAS perdido devolve `reactivation_conflict` em vez de criar segunda Person.

**Invariante:** um e-mail tem no máximo uma identidade reutilizável; exclusão LGPD é irreversível por desenho.

---

### P2-04 — Quantidade inteira e valor monetário estritos

**Defeito:** `Math.floor(1.5)` → 1; `Math.max(1, Number(x) || 1)` e `parseInt(x) || 1` **transformavam entrada inválida em valor válido** em silêncio. O erro do cliente (ou do atacante) deixava de existir e o número gravado não era o número enviado.

**Correção:** `shared/numericInput.ts`.
- `parseQuantity`: aceita inteiro finito ou texto de dígitos; recusa NaN, infinitos, fracionário, negativo, zero (quando exige positivo), vazio, texto com letras/`1e3`/`0x10`, booleano, objeto e valor acima do limite de negócio — cada recusa com motivo próprio.
- `parseMoneyBRL`: converte em **centavos por aritmética inteira** (nunca `valor * 100` em ponto flutuante), aceita vírgula, recusa mais de duas casas (`precisao`), negativos e acima do limite.
- `Math.floor` removido da reserva de estoque: quantidade fracionária não é truncada para um valor "válido" — é recusada, e nenhum saldo se move.

**Invariante:** o número gravado é sempre o número enviado; entrada inválida não vira default.

---

### P2-06 — Uma avaliação lógica por (submissão, avaliador)

**Defeito:** `manageAward.saveEvaluation` fazia `filter → create`. Duas requisições simultâneas (duplo clique, retry do cliente, duas abas) liam "não existe" ao mesmo tempo e criavam **duas** avaliações; o score era somado duas vezes, distorcendo média e ranking.

**Correção:** `shared/evaluationIntegrity.ts`.
- `saveEvaluationOnce`: lê as avaliações do par, **atualiza a sobrevivente determinística** quando existe e só cria quando não existe; duplicatas pré-existentes são encerradas (`is_deleted`) e o número é devolvido.
- `groupEvaluationsByReviewer` / `dedupeEvaluationsForScoring`: **todo** cálculo de score/ranking deduplica por par, com desempate estável `(created_date, id)` — mesma resposta para qualquer ordem de leitura.
- Falhas devolvem estado explícito (`read_unavailable`, `create_failed`, `update_failed`, `create_unconfirmed`); a função nunca lança.

**Invariante:** duplicata deixada por corrida não infla score; retry converge para o mesmo registro.

---

### P2-08 — Reserva de repasse: valor validado e trilha obrigatória

**Defeito:** `setReserve` usava `Math.max(0, Number(amount) || 0)`: `"abc"` → 0, `NaN` → 0, `-5` → 0. A alteração era aplicada no Stripe e no registro local **sem trilha obrigatória** — sem autor, valor anterior ou motivo.

**Correção:** `managePayouts`.
- Valor passa por `parseMoneyBRL` e vira **centavos** por aritmética inteira; inválido → `400` com `field: "amount"` e **nada** acontece.
- **Trilha obrigatória antes do efeito externo**: ator, evento, conta, valores anterior/novo, moeda, motivo, `correlation_id` e `resultado`. Sem trilha confirmada → `503` e nenhum efeito no provedor.
- Chave determinística da trilha: retry da **mesma** operação reconhece a trilha existente em vez de duplicá-la.
- Estado local confirmado por **leitura** depois da escrita (resposta otimista não é prova).
- Falha do provedor → `502`, valor local intacto, tentativa registrada na trilha.

**Invariante:** nenhum valor financeiro muda sem evidência correspondente; nenhuma entrada inválida é convertida em zero.

---

## 4. Evidências de teste

| Suíte | Testes | Resultado |
|---|---|---|
| P2 (novos) | 86 | 86 pass |
| F4 — reserva/estoque/fulfillment | 70 | 70 pass |
| Estornos (refund) | 115 | 115 pass |
| P1 — hardening | 31 | 31 pass |
| Migração financeira | 25 | 25 pass |
| Fase 3 — privacidade/auditoria | 35 | 35 pass |
| Autorização de sessão/trilha | 13 | 13 pass |
| CSV injection | 12 | 12 pass |
| Auditoria de acesso | 7 | 7 pass |

Build de produção: exit 0. Lint dos módulos alterados: limpo.

Os testes de assinatura calculam HMAC com `node:crypto` (implementação independente da do módulo). Os testes HTTP usam um cliente falso que injeta falha por operação, e os de integridade usam um banco em memória com a mesma semântica de `updateMany` (CAS por documento).

## 5. Riscos residuais declarados

1. **Corrida de criação de avaliação** — sem índice único, duas requisições simultâneas ainda podem criar dois registros. O efeito no score é neutralizado pelo dedupe e a próxima gravação converge encerrando o excedente. A janela não distorce mais média nem ranking.
2. **Reserva de cupom órfã sem pedido** — permanece viva até o vencimento (15 min) e é encerrada pela reconciliação; nunca devolve uso de pedido vivo.
3. **Trilha de reativação de Person é best-effort** — a reativação em si é CAS e idempotente; falha de trilha não cria duplicata nem desfaz a identidade, mas o registro de auditoria pode faltar (`audited: false`).
4. **Cupons legados** — pedidos anteriores ao ciclo de vida não têm reserva; o diagnóstico apenas os conta, nunca apaga. O marcador do pedido continua sendo a autoridade do contador para eles.

## 6. O que NÃO foi feito neste bloco

- Triagem das 27 vulnerabilidades de dependência.
- Análise do legado de `AwardCategory` / `AwardNomination`.
- Testes de ponta a ponta (E2E) com perfis distintos.

## 7. Perguntas para revisão externa

1. O ciclo `reserved → committed | released` com CAS no próprio registro cobre todos os desfechos de checkout (falha de criação, expiração, estorno integral, estorno parcial)? Falta algum estado terminal?
2. A escolha "trilha antes do efeito externo" para operações de repasse está correta, ou o ideal seria trilha de intenção + trilha de resultado (dois registros)?
3. A reativação de Person inativa por CAS é a política adequada para LGPD, ou um cadastro inativo deveria sempre gerar identidade nova?
4. A deduplicação na leitura (em vez de unicidade no banco) é aceitável como estratégia permanente, dado que a plataforma não permite índice único?
5. Existe algum caminho em que um estorno parcial deixe a reserva de cupom em `committed` indevidamente?
