// P2-02 (2026-11-22) — VERIFICAÇÃO DE ASSINATURA DO WEBHOOK STRIPE.
//
// DEFEITO CORRIGIDO: o parser guardava apenas a ÚLTIMA assinatura `v1` do header
// (`if (k === "v1") v1 = val;`). Quando o header traz mais de um `v1` — rotação
// de segredo, reenvio com assinatura nova ao lado da antiga — qualquer assinatura
// válida que não fosse a última era descartada e o webhook LEGÍTIMO era recusado
// com 400. O Stripe reenvia, o processamento do pagamento atrasa e o estado local
// diverge do provedor.
//
// PROTOCOLO (Stripe): header `stripe-signature: t=<unix>,v1=<hex>[,v1=<hex>...]`.
// O payload assinado é `"<t>.<corpo bruto da requisição>"`. Qualquer `v1` que
// corresponda ao HMAC-SHA256 do segredo vigente é prova de autenticidade.
//
// GARANTIAS IMPLEMENTADAS AQUI:
//   1. TODAS as assinaturas `v1` são preservadas e testadas.
//   2. O corpo é verificado EXATAMENTE como recebido (o chamador passa o texto
//      bruto; nada é reserializado).
//   3. Timestamp inteiro positivo e dentro da janela de tolerância (passado E
//      futuro) — replay fora da janela é recusado.
//   4. Comparação em tempo constante (XOR acumulado, sem saída antecipada).
//   5. Vários segredos são aceitos (rotação): basta UM par (segredo, v1) casar.
//   6. Header ausente, malformado, sem `v1`, com `t` duplicado divergente ou
//      timestamp inválido é recusado com motivo — nunca "aceito por engano".
//   7. Nenhuma mensagem de erro carrega segredo, assinatura ou payload.
//
// A proteção contra REPLAY não é o timestamp: é a idempotência do processamento
// (chaves de trilha determinísticas + claims/CAS no fulfillment). O timestamp
// limita a janela; a idempotência garante que repetir não duplica efeito.

export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureParse =
  | { ok: true; timestamp: number; signatures: string[] }
  | { ok: false; reason: string };

export type SignatureVerification =
  | { ok: true; timestamp: number; matched: number }
  | { ok: false; reason: string };

/** Separa `t` e TODAS as `v1` do header. Nunca lança. */
export function parseStripeSignature(header: unknown): SignatureParse {
  const raw = typeof header === "string" ? header.trim() : "";
  if (!raw) return { ok: false, reason: "assinatura_ausente" };

  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  let timestampRaw = "";
  const signatures: string[] = [];

  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) return { ok: false, reason: "header_malformado" };
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();

    if (key === "t") {
      if (!value) return { ok: false, reason: "timestamp_invalido" };
      if (timestampRaw && timestampRaw !== value) {
        // Dois `t` divergentes: não há como saber qual payload foi assinado.
        return { ok: false, reason: "timestamp_conflitante" };
      }
      timestampRaw = value;
    } else if (key === "v1") {
      if (!value) return { ok: false, reason: "assinatura_malformada" };
      signatures.push(value.toLowerCase());
    }
    // Outras versões de esquema (ex.: v0) são ignoradas pelo protocolo atual.
  }

  if (!timestampRaw) return { ok: false, reason: "timestamp_ausente" };
  if (!/^[0-9]+$/.test(timestampRaw)) return { ok: false, reason: "timestamp_invalido" };
  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { ok: false, reason: "timestamp_invalido" };
  }
  if (signatures.length === 0) return { ok: false, reason: "sem_assinatura_v1" };

  return { ok: true, timestamp, signatures };
}

/** Comparação de hex em tempo constante (comprimento diferente = falha). */
export function timingSafeEqualHex(a: unknown, b: unknown): boolean {
  const left = String(a ?? "").toLowerCase();
  const right = String(b ?? "").toLowerCase();
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    const ca = i < left.length ? left.charCodeAt(i) : 0;
    const cb = i < right.length ? right.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verifica o header contra o corpo BRUTO. Aceita um segredo ou uma lista
 * (rotação: segredo novo + anterior). Nunca lança.
 */
export async function verifyStripeSignature(opts: {
  body: string;
  header: unknown;
  secrets: string | string[];
  toleranceSeconds?: number;
  nowMs?: number;
}): Promise<SignatureVerification> {
  const parsed = parseStripeSignature(opts.header);
  if (!parsed.ok) return parsed;

  const tolerance = Number.isFinite(opts.toleranceSeconds)
    ? Number(opts.toleranceSeconds)
    : DEFAULT_TOLERANCE_SECONDS;
  const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    return { ok: false, reason: "timestamp_fora_da_janela" };
  }

  const list = (Array.isArray(opts.secrets) ? opts.secrets : [opts.secrets])
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  if (list.length === 0) return { ok: false, reason: "segredo_ausente" };

  const body = typeof opts.body === "string" ? opts.body : "";
  const payload = `${parsed.timestamp}.${body}`;

  for (const secret of list) {
    const expected = await hmacSha256Hex(secret, payload);
    for (let i = 0; i < parsed.signatures.length; i++) {
      if (timingSafeEqualHex(expected, parsed.signatures[i])) {
        return { ok: true, timestamp: parsed.timestamp, matched: i };
      }
    }
  }
  return { ok: false, reason: "assinatura_invalida" };
}