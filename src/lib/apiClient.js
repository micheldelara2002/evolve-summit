/**
 * Wrapper para chamadas de APIs externas com retry (exponential backoff) e timeout.
 * Mantém a mesma assinatura de retorno das integrações originais.
 */
import { base44 } from "@/api/base44Client";

const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY = 600;
const UPLOAD_TIMEOUT = 30_000;
const EMAIL_TIMEOUT = 15_000;

/**
 * Adiciona timeout a uma promise. Rejeita com Error("Timeout") se exceder.
 */
export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Tempo limite excedido. Tente novamente.")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Executa fn com retry em caso de falha (exponential backoff).
 * Não retenta erros 4xx (cliente) — apenas erros de rede/timeout/5xx.
 */
async function withRetry(fn, { retries = DEFAULT_RETRIES, baseDelay = DEFAULT_BASE_DELAY } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status || err?.status;
      if (status && status >= 400 && status < 500) throw err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, baseDelay * Math.pow(2, attempt)));
      }
    }
  }
  throw lastErr;
}

/** Upload de arquivo com timeout + retry */
export async function uploadFile(file) {
  return withRetry(
    () => withTimeout(
      base44.integrations.Core.UploadFile({ file }),
      UPLOAD_TIMEOUT
    )
  );
}

/** Envio de email com timeout + retry */
export async function sendEmail(params) {
  return withRetry(
    () => withTimeout(
      base44.integrations.Core.SendEmail(params),
      EMAIL_TIMEOUT
    )
  );
}