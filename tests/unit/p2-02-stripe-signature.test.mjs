// P2-02 (2026-11-22) — ASSINATURA DO WEBHOOK STRIPE COM MÚLTIPLAS `v1`.
//
// Defeito original: o parser guardava só a ÚLTIMA `v1` do header. Um header com
// a assinatura anterior e a nova (rotação de segredo), ou qualquer combinação em
// que a válida não fosse a última, recusava webhook LEGÍTIMO com 400.
//
// As assinaturas são calculadas com node:crypto — implementação independente da
// usada pelo módulo — para que a verificação seja provada contra fonte externa.

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  parseStripeSignature,
  verifyStripeSignature,
  timingSafeEqualHex,
  DEFAULT_TOLERANCE_SECONDS,
} from "../../base44/shared/stripeSignature.ts";
import { buildAuditKey } from "../../base44/shared/auditTrail.ts";

const SECRET = "whsec_primary";
const OLD_SECRET = "whsec_previous";
const BODY = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } });

const NOW_MS = 1_700_000_000_000;
const T = Math.floor(NOW_MS / 1000);

function sign(secret, body = BODY, t = T) {
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
}

function header(t, sigs) {
  return [`t=${t}`, ...sigs.map((s) => `v1=${s}`)].join(",");
}

const verify = (h, secrets = SECRET, extra = {}) =>
  verifyStripeSignature({ body: BODY, header: h, secrets, nowMs: NOW_MS, ...extra });

test("uma assinatura v1 válida é aceita", async () => {
  const out = await verify(header(T, [sign(SECRET)]));
  assert.equal(out.ok, true);
  assert.equal(out.matched, 0);
});

test("múltiplas v1 são preservadas no parser (nenhuma é descartada)", () => {
  const parsed = parseStripeSignature(header(T, [sign(SECRET), sign(SECRET), sign(SECRET)]));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.signatures.length, 3);
});

test("primeira v1 válida e última inválida — DEFEITO ORIGINAL, agora aceito", async () => {
  const out = await verify(header(T, [sign(SECRET), "0".repeat(64)]));
  assert.equal(out.ok, true);
  assert.equal(out.matched, 0);
});

test("última v1 válida e primeira inválida é aceita", async () => {
  const out = await verify(header(T, ["f".repeat(64), sign(SECRET)]));
  assert.equal(out.ok, true);
  assert.equal(out.matched, 1);
});

test("todas inválidas são recusadas", async () => {
  const out = await verify(header(T, ["a".repeat(64), "b".repeat(64)]));
  assert.equal(out.ok, false);
  assert.equal(out.reason, "assinatura_invalida");
});

test("rotação de segredo: antigo e novo no mesmo header", async () => {
  const both = await verify(header(T, [sign(OLD_SECRET), sign(SECRET)]), [SECRET, OLD_SECRET]);
  assert.equal(both.ok, true, "basta um par (segredo, v1) casar");
  const onlyNew = await verify(header(T, [sign(OLD_SECRET)]), SECRET);
  assert.equal(onlyNew.ok, false);
  assert.equal(onlyNew.reason, "assinatura_invalida");
  assert.equal((await verify(header(T, [sign(OLD_SECRET)]), [SECRET, OLD_SECRET])).ok, true);
});

test("payload alterado é recusado (verificação sobre os bytes originais)", async () => {
  const h = header(T, [sign(SECRET)]);
  const tampered = await verifyStripeSignature({
    body: BODY.replace("pi_1", "pi_2"), header: h, secrets: SECRET, nowMs: NOW_MS,
  });
  assert.equal(tampered.ok, false);
  const spaced = await verifyStripeSignature({
    body: `${BODY} `, header: h, secrets: SECRET, nowMs: NOW_MS,
  });
  assert.equal(spaced.ok, false, "nada é reserializado nem normalizado");
});

test("timestamp alterado no header invalida a assinatura", async () => {
  const out = await verify(header(T + 10, [sign(SECRET, BODY, T)]));
  assert.equal(out.ok, false);
  assert.equal(out.reason, "assinatura_invalida");
});

test("timestamp expirado ou futuro fora da tolerância é recusado", async () => {
  const oldT = T - (DEFAULT_TOLERANCE_SECONDS + 100);
  const expired = await verify(header(oldT, [sign(SECRET, BODY, oldT)]));
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "timestamp_fora_da_janela");

  const futureT = T + (DEFAULT_TOLERANCE_SECONDS + 100);
  const future = await verify(header(futureT, [sign(SECRET, BODY, futureT)]));
  assert.equal(future.ok, false);
  assert.equal(future.reason, "timestamp_fora_da_janela");
});

test("header malformado, sem v1, vazio ou com timestamp inválido é recusado", async () => {
  assert.equal((await verify("garbage")).reason, "header_malformado");
  assert.equal((await verify("")).reason, "assinatura_ausente");
  assert.equal((await verify(`t=${T}`)).reason, "sem_assinatura_v1");
  assert.equal((await verify("t=abc,v1=deadbeef")).reason, "timestamp_invalido");
  assert.equal((await verify("t=-5,v1=deadbeef")).reason, "timestamp_invalido");
  assert.equal((await verify("t=,v1=deadbeef")).reason, "timestamp_invalido");
  assert.equal((await verify(`t=${T},v1=`)).reason, "assinatura_malformada");
  assert.equal((await verify(`t=${T},v1=a,t=${T + 1},v1=b`)).reason, "timestamp_conflitante");
});

test("versões de esquema desconhecidas são ignoradas (só v1 autentica)", async () => {
  assert.equal((await verify(`t=${T},v0=abc,v1=${sign(SECRET)}`)).ok, true);
});

test("espaços e ordem dos itens não quebram o parser", async () => {
  assert.equal((await verify(` v1=${sign(SECRET)} , t=${T} `)).ok, true);
});

test("segredo ausente é recusado (nunca aceita por falta de configuração)", async () => {
  const out = await verify(header(T, [sign(SECRET)]), []);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "segredo_ausente");
});

test("comparação de hex é correta e não aceita prefixo", () => {
  assert.equal(timingSafeEqualHex("abcd", "abcd"), true);
  assert.equal(timingSafeEqualHex("ABCD", "abcd"), true);
  assert.equal(timingSafeEqualHex("abcd", "abce"), false);
  assert.equal(timingSafeEqualHex("abcd", "abc"), false);
  assert.equal(timingSafeEqualHex("", "abc"), false);
  assert.equal(timingSafeEqualHex("", ""), true);
});

test("replay: a assinatura continua válida; a idempotência é do processamento", async () => {
  const h = header(T, [sign(SECRET)]);
  assert.equal((await verify(h)).ok, true);
  assert.equal((await verify(h)).ok, true, "o mesmo evento entregue duas vezes autentica nas duas");
  // O que impede efeito duplicado é a chave determinística da trilha: a mesma
  // referência sempre produz a mesma chave.
  assert.equal(
    buildAuditKey("pagamento_confirmado", "pi_1"),
    buildAuditKey("pagamento_confirmado", "pi_1"),
  );
});