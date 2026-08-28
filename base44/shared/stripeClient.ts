// Minimal Stripe REST API helper (no SDK dependency — uses fetch + STRIPE_SECRET_KEY).
// All amounts handled in cents at the Stripe boundary; BRL decimal elsewhere.

import { secrets } from "base44:runtime";

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2025-10-29.clover";

function authHeaders(idempotencyKey?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${secrets.get("STRIPE_SECRET_KEY")}`,
    "Stripe-Version": STRIPE_VERSION,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) h["Idempotency-Key"] = idempotencyKey;
  return h;
}

async function stripeRequest(path: string, params: URLSearchParams, idempotencyKey?: string, method = "POST") {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: authHeaders(idempotencyKey),
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `Stripe error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export async function createPaymentIntent(opts: {
  amountCents: number;
  currency: string;
  orderId: string;
  eventId: string;
  metadata?: Record<string, string>;
}): Promise<any> {
  const { amountCents, currency, orderId, eventId, metadata } = opts;
  const params = new URLSearchParams();
  params.append("amount", String(amountCents));
  params.append("currency", currency.toLowerCase());
  params.append("automatic_payment_methods[enabled]", "true");
  params.append("metadata[order_id]", orderId);
  params.append("metadata[event_id]", eventId);
  params.append("metadata[base44_app_id]", secrets.get("BASE44_APP_ID") || "");
  if (metadata) for (const k of Object.keys(metadata)) params.append(`metadata[${k}]`, metadata[k]);
  return stripeRequest("/payment_intents", params, `pi_create_${orderId}`);
}

export async function retrievePaymentIntent(intentId: string): Promise<any> {
  const res = await fetch(`${STRIPE_API}/payment_intents/${intentId}`, {
    headers: { Authorization: `Bearer ${secrets.get("STRIPE_SECRET_KEY")}`, "Stripe-Version": STRIPE_VERSION },
  });
  return res.json();
}

export async function createRefund(opts: {
  paymentIntentId: string;
  amountCents?: number; // partial if provided
  reason?: string;
  idempotencyKey: string;
}): Promise<any> {
  const { paymentIntentId, amountCents, reason, idempotencyKey } = opts;
  const params = new URLSearchParams();
  params.append("payment_intent", paymentIntentId);
  if (amountCents) params.append("amount", String(amountCents));
  if (reason) params.append("reason", reason);
  params.append("metadata[base44_app_id]", secrets.get("BASE44_APP_ID") || "");
  return stripeRequest("/refunds", params, idempotencyKey);
}

// Webhook signature verification using Web Crypto (async).
export async function constructStripeEvent(body: string, signature: string, secret: string): Promise<any> {
  const parts = signature.split(",").map((s) => s.trim());
  let t = "", v1 = "";
  for (const p of parts) {
    const [k, val] = p.split("=");
    if (k === "t") t = val;
    if (k === "v1") v1 = val;
  }
  if (!t || !v1) throw new Error("Invalid Stripe signature format");
  const signedPayload = `${t}.${body}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signedPayload));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected !== v1) throw new Error("Invalid Stripe signature");
  const tolerance = 300; // 5 min
  if (Math.abs(Date.now() / 1000 - parseInt(t, 10)) > tolerance) throw new Error("Stripe signature timestamp out of tolerance");
  return JSON.parse(body);
}