// safeImageFetch (2026-10-17) — Busca SEGURA de imagens para embutir em PDF.
// Motivação: o fetch anterior de logos (ticketPdf) não limitava destino, tempo
// nem tamanho — SSRF (localhost/privados/link-local/metadata), downloads
// ilimitados e bloqueio de worker.
//
// Garantias:
//   - Somente HTTPS; hostname bloqueado se localhost/.local/.internal,
//     endpoint de metadata, ou IP literal privado/reservado (v4 e v6).
//   - SEM redirects (redirect: 'error') — nenhuma revalidação textual de
//     destino pode ser burlada por redirecionamento.
//   - Timeout explícito (AbortSignal.timeout) e leitura STREAMING do corpo com
//     teto de bytes — nunca arrayBuffer() ilimitado.
//   - MIME (image/png|jpeg) + assinatura mágica validados; SVG/HTML/other
//     rejeitados.
//   - Nunca registra a URL (pode conter tokens/PII) — só o motivo da falha.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB por imagem
export const IMAGE_FETCH_TIMEOUT_MS = 6000;
export const MAX_IMAGE_DIM = 4096; // dimensão máxima aceita ao desenhar

function isBlockedHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal' || h === 'metadata.goog') return true;

  // IPv4 literal — ranges privados/reservados
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return true;
    const a = o[0], b = o[1];
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    ) return true;
    return false;
  }

  // IPv6 literal — loopback, ULA (fc00::/7), link-local (fe80::/10), mapeado
  if (h.includes(':')) {
    const s = h.replace(/^\[|\]$/g, '').toLowerCase();
    if (s.startsWith('::ffff:')) return isBlockedHost(s.slice(7));
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('fc') || s.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(s)) return true;
    return false;
  }
  return false;
}

export type SafeImageResult =
  | { ok: true; data: Uint8Array; format: string }
  | { ok: false; reason: string };

export async function fetchSafeImage(url?: string | null): Promise<SafeImageResult> {
  if (!url || typeof url !== 'string' || !url.trim()) return { ok: false, reason: 'missing_url' };

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'scheme_not_https' };
  if (isBlockedHost(parsed.hostname)) return { ok: false, reason: 'blocked_host' };

  try {
    // redirect: 'error' — qualquer redirecionamento falha a busca (controle).
    const res = await fetch(parsed.toString(), {
      redirect: 'error',
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: 'http_' + res.status };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/png') && !ct.startsWith('image/jpeg')) {
      return { ok: false, reason: 'unsupported_mime' };
    }
    if (!res.body) return { ok: false, reason: 'empty_body' };

    // Leitura em streaming com teto de bytes — aborta além do limite.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_IMAGE_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
    if (total < 8) return { ok: false, reason: 'too_small' };

    const data = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { data.set(c, offset); offset += c.length; }

    // Assinatura mágica: PNG (89 50 4E 47) ou JPEG (FF D8 FF) — rejeita
    // SVG/HTML/conteúdo disfarçado com MIME falso.
    const isPng = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
    const isJpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    if (!isPng && !isJpeg) return { ok: false, reason: 'invalid_signature' };

    return { ok: true, data, format: isPng ? 'PNG' : 'JPEG' };
  } catch (e: any) {
    const name = String(e?.name || '');
    if (name === 'AbortError' || name === 'TimeoutError') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'fetch_failed' };
  }
}