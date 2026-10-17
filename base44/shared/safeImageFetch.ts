// safeImageFetch (2026-10-17) — Busca SEGURA de imagens para embutir em PDF.
// Motivação: o fetch anterior de logos (ticketPdf) não limitava destino, tempo
// nem tamanho — SSRF (localhost/privados/link-local/metadata), downloads
// ilimitados e bloqueio de worker.
//
// Garantias:
//   - Somente HTTPS; hostname bloqueado se localhost/.local/.internal,
//     endpoint de metadata, ou IP literal privado/reservado (v4 e v6).
//   - RESOLUÇÃO DNS validada (2026-10-17): o hostname é resolvido (A + AAAA)
//     e QUALQUER endereço privado/reservado bloqueia a busca — cobre nomes
//     que apontam para IPs internos (ex.: localtest.me → 127.0.0.1), não só
//     literais. Fail-closed: falha da verificação DNS bloqueia a busca.
//   - SEM redirects: redirect 'manual' (o runtime não implementa 'error' —
//     testado 2026-10-17) + recusa explícita de respostas 3xx/opacas —
//     nenhuma revalidação textual de destino pode ser burlada por
//     redirecionamento. Residual: janela TOCTOU mínima entre a resolução e o
//     fetch; mitigada por HTTPS + recusa de redirect + assinatura de imagem
//     + re-verificação DNS pós-fetch.
//   - Timeout explícito (AbortSignal.timeout) e leitura STREAMING do corpo com
//     teto de bytes — nunca arrayBuffer() ilimitado.
//   - MIME (image/png|jpeg) + assinatura mágica validados; SVG/HTML/other
//     rejeitados.
//   - Nunca registra a URL (pode conter tokens/PII) — só o motivo da falha.
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB por imagem
export const IMAGE_FETCH_TIMEOUT_MS = 6000;
export const MAX_IMAGE_DIM = 4096; // dimensão máxima aceita ao desenhar
// Fail-closed: se a resolução DNS não estiver disponível no runtime, TODA
// busca externa é bloqueada (o PDF perde o logo, mas nunca fica inseguro).
const DNS_CHECK_ENABLED = true;

// IP literal privado/reservado (v4 e v6) — usado por hostname literal e pela
// validação DNS (mesma régua para os endereços resolvidos).
export function isPrivateIpLiteral(ip: string): boolean {
  const s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!s) return true;
  // IPv4
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
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
  // IPv6 — loopback, ULA (fc00::/7), link-local (fe80::/10), mapeado
  if (s.includes(':')) {
    if (s.startsWith('::ffff:')) return isPrivateIpLiteral(s.slice(7));
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('fc') || s.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(s)) return true;
    return false;
  }
  return true; // não é IP — bloqueia por conservadorismo
}

function isBlockedHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal' || h === 'metadata.goog') return true;
  if (h.match(/^(\d{1,3}\.){3}\d{1,3}$/) || h.includes(':')) {
    return isPrivateIpLiteral(h); // literal IPv4/IPv6
  }
  return false;
}

function isIpLiteral(s: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(s) || s.includes(':');
}

// Valida a RESOLUÇÃO do hostname (não só o texto). Retorna null se seguro ou
// um motivo de bloqueio. Fail-closed em qualquer falha da verificação.
// Nota de runtime (testado 2026-10-17): Deno.resolveDns inclui CNAMEs na
// resposta de 'A' — só os registros que são IP literal são avaliados; os IPs
// finais acompanham a cadeia. Consulta que falha (ENOTFOUND) → bloqueada.
async function dnsCheck(hostname: string): Promise<string | null> {
  if (!DNS_CHECK_ENABLED) return null;
  try {
    const [a, aaaa] = await Promise.all([
      Deno.resolveDns(hostname, 'A').catch(() => null),
      Deno.resolveDns(hostname, 'AAAA').catch(() => null),
    ]);
    const ips: string[] = [];
    let queryFailed = false;
    for (const recs of [a, aaaa] as (string[] | null)[]) {
      if (recs === null) { queryFailed = true; continue; }
      for (const r of recs) {
        if (isIpLiteral(String(r))) ips.push(String(r));
      }
    }
    if (ips.length === 0) return 'dns_unresolved'; // ENOTFOUND ou só CNAME — fail-closed
    for (const ip of ips) {
      if (isPrivateIpLiteral(ip)) return 'dns_private_ip';
    }
    return null;
  } catch {
    return 'dns_check_failed';
  }
}

// Combina sinais de abort (timeout + orçamento externo). Fallback manual para
// runtimes sem AbortSignal.any — aborta com o reason do primeiro sinal que dispara.
function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as any).any === 'function') return (AbortSignal as any).any(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      try { controller.abort(s.reason); } catch { try { controller.abort(); } catch { /* ignore */ } }
      break;
    }
    s.addEventListener('abort', () => {
      try { controller.abort(s.reason); } catch { try { controller.abort(); } catch { /* ignore */ } }
    }, { once: true });
  }
  return controller.signal;
}

export type SafeImageResult =
  | { ok: true; data: Uint8Array; format: string }
  | { ok: false; reason: string };

export async function fetchSafeImage(
  url?: string | null,
  opts?: { signal?: AbortSignal; onBytes?: (n: number) => void }
): Promise<SafeImageResult> {
  if (!url || typeof url !== 'string' || !url.trim()) return { ok: false, reason: 'missing_url' };

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'scheme_not_https' };
  if (isBlockedHost(parsed.hostname)) return { ok: false, reason: 'blocked_host' };
  // Hostname NÃO-literal: valida os endereços REAIS da resolução DNS.
  const h = parsed.hostname.replace(/\.$/, '');
  if (!h.match(/^(\d{1,3}\.){3}\d{1,3}$/) && !h.includes(':')) {
    const dnsFail = await dnsCheck(h);
    if (dnsFail) return { ok: false, reason: dnsFail };
  }

  try {
    // redirect: 'error' — qualquer redirecionamento falha a busca (controle).
    // Sinal combinado: timeout próprio + sinal externo do chamador (orçamento
    // global do pool de imagens — aborta downloads EM ANDAMENTO).
    // AbortSignal.any NÃO existe neste runtime (testado 2026-10-17) —
    // combinação manual com fallback.
    const combined = combineAbortSignals(
      opts?.signal
        ? [AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS), opts.signal]
        : [AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS)]
    );
    // ATENÇÃO (descoberto em teste, 2026-10-17): o fetch DESTE runtime NÃO
    // implementa 'error' ("use manual and check the response status code") —
    // com 'error', TODA busca lançava TypeError (fetch_failed) e nenhum logo
    // era carregado. redirect: 'manual' + recusa explícita de 3xx: resposta
    // de redirecionamento (ou opaca, status 0) é RECUSADA — nenhuma
    // revalidação textual de destino pode ser burlada por redirecionamento.
    const res = await fetch(parsed.toString(), {
      redirect: 'manual',
      signal: combined,
    });
    if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { ok: false, reason: 'redirect_refused' };
    }
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
      // Contabiliza bytes em tempo real (orçamento global do pool pode abortar
      // ESTA leitura no meio do streaming).
      try { opts?.onBytes?.(value.length); } catch { /* contagem é best-effort */ }
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

    // Re-verificação DNS PÓS-fetch (defesa em profundidade contra DNS
    // rebinding na janela TOCTOU resolução→conexão): se a resolução ATUAL do
    // hostname revelar IP privado/reservado, o corpo é DESCARTADO — o PDF
    // perde a imagem (falha opcional), nunca incorpora conteúdo do destino.
    if (!h.match(/^(\d{1,3}\.){3}\d{1,3}$/) && !h.includes(':')) {
      const dnsRecheck = await dnsCheck(h);
      if (dnsRecheck) return { ok: false, reason: 'post_fetch_' + dnsRecheck };
    }

    return { ok: true, data, format: isPng ? 'PNG' : 'JPEG' };
  } catch (e: any) {
    const name = String(e?.name || '');
    if (opts?.signal?.aborted) return { ok: false, reason: 'aborted_by_caller' };
    if (name === 'AbortError' || name === 'TimeoutError') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'fetch_failed' };
  }
}