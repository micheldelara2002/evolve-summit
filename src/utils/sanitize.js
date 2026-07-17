/**
 * Sanitiza texto livre para prevenir XSS (Cross-Site Scripting).
 * Remove tags HTML, protocolos perigosos (javascript:, data:) e event handlers (on*).
 *
 * Uso: sanitizeText(userInput) antes de salvar no banco.
 * Isso é defense-in-depth — o React já escapa HTML em {value},
 * mas a sanitização na origem protege contextos não-React (PDFs, e-mails, etc).
 */
export function sanitizeText(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/<[^>]*>/g, "")           // Remove tags HTML: <script>, <img onerror=...>, etc
    .replace(/javascript:/gi, "")      // Remove protocolo javascript:
    .replace(/data:text\/html/gi, "")  // Remove data: HTML injection
    .replace(/\bon\w+\s*=/gi, "")     // Remove event handlers: onclick=, onerror=, etc
    .trim();
}