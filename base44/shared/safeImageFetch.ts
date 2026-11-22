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

// ===== P1-02 (SEC-SSRF) — NORMALIZAÇÃO E CLASSIFICAÇÃO DE IP =====
//
// DEFEITO CORRIGIDO: a versão anterior só reconhecia IPv4-mapped IPv6 na forma
// pontuada (`::ffff:127.0.0.1`). A forma HEXADECIMAL (`::ffff:7f00:1`), que é
// equivalente e aceita por qualquer parser, atravessava a validação e permitia
// alcançar 127.0.0.1. O mesmo valia para IPv4 embutido em 6to4/NAT64 e para
// IPv4 em formato decimal/octal/hexadecimal único.
//
// Agora a validação é feita sobre a REPRESENTAÇÃO NUMÉRICA do endereço:
//   1. IPv4 (pontuado, decimal único, octal, hexadecimal) → classificação v4;
//   2. IPv6 → 8 grupos de 16 bits (compacto ou expandido);
//   3. IPv4 embutido (mapeado ::ffff:0:0/96, compatível ::/96, NAT64 64:ff9b::/96,
//      6to4 2002::/16) é EXTRAÍDO e classificado como IPv4;
//   4. qualquer endereço que não seja globalmente roteável é bloqueado;
//   5. endereço malformado/irreconhecível bloqueia (fail-closed).
//
// A mesma régua vale para hostname literal e para TODAS as respostas DNS.

function parseIpv4(ip: string): number[] | null {
  const parts = String(ip || '').trim().split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^(0[xX][0-9a-fA-F]+|\d{1,3})$/.test(part)) return null;
    const n = /^0[xX]/.test(part) ? parseInt(part, 16) : parseInt(part, 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

// IPv4 em formato numérico único, aceito por parsers de URL e por bibliotecas
// HTTP: "2130706433" (decimal), "0x7f000001" (hex), "017700000001" (octal).
function parseIpv4Numeric(ip: string): number[] | null {
  const t = String(ip || '').trim();
  let n: number;
  if (/^\d{1,10}$/.test(t)) {
    n = Number(t);
  } else if (/^0[xX][0-9a-fA-F]{1,8}$/.test(t)) {
    n = parseInt(t, 16);
  } else if (/^0[0-7]{1,11}$/.test(t)) {
    n = parseInt(t, 8);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function isBlockedIpv4(o: number[]): boolean {
  if (!Array.isArray(o) || o.length !== 4) return true;
  if (o.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = o;
  if (a === 0) return true;                                        // "este" / não roteável
  if (a === 10) return true;                                       // privado
  if (a === 127) return true;                                      // loopback
  if (a === 100 && b >= 64 && b <= 127) return true;               // CGNAT
  if (a === 169 && b === 254) return true;                         // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true;                // privado
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;   // IETF / TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true;              // 6to4 relay anycast
  if (a === 192 && b === 168) return true;                         // privado
  if (a === 198 && (b === 18 || b === 19)) return true;            // benchmarking
  if (a === 198 && b === 51 && c === 100) return true;             // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;              // TEST-NET-3
  if (a >= 224) return true;                                       // multicast/reservado/broadcast
  return false;
}

// IPv6 → 8 grupos de 16 bits. Suporta forma compacta ("::"), expandida, zona
// ("%eth0") e IPv4 embutido no último bloco. null = inválido.
function parseIpv6(ip: string): number[] | null {
  let t = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!t.includes(':')) return null;
  const zone = t.indexOf('%');
  if (zone >= 0) t = t.slice(0, zone);

  // IPv4 embutido no fim: a.b.c.d → dois grupos hex.
  const lastColon = t.lastIndexOf(':');
  if (lastColon < 0) return null;
  const tail = t.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    const g1 = ((v4[0] << 8) | v4[1]).toString(16);
    const g2 = ((v4[2] << 8) | v4[3]).toString(16);
    t = `${t.slice(0, lastColon + 1)}${g1}:${g2}`;
  }

  const toGroup = (g: string): number | null => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : null);
  const dbl = t.indexOf('::');
  let head: string[];
  let tailGroups: string[] = [];
  if (dbl >= 0) {
    if (t.indexOf('::', dbl + 1) >= 0) return null; // mais de uma compressão
    const left = t.slice(0, dbl);
    const right = t.slice(dbl + 2);
    head = left ? left.split(':') : [];
    tailGroups = right ? right.split(':') : [];
  } else {
    head = t.split(':');
  }
  const h = head.map(toGroup);
  const tl = tailGroups.map(toGroup);
  if (h.some((g) => g === null) || tl.some((g) => g === null)) return null;
  const headNums = h as number[];
  const tailNums = tl as number[];
  if (dbl >= 0) {
    const missing = 8 - (headNums.length + tailNums.length);
    if (missing < 1) return null;
    return [...headNums, ...new Array(missing).fill(0), ...tailNums];
  }
  return headNums.length === 8 ? headNums : null;
}

function ipv4FromGroups(hi: number, lo: number): number[] {
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
}

function isBlockedIpv6(g: number[]): boolean {
  if (!Array.isArray(g) || g.length !== 8) return true;
  const isZeroRange = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);

  if (isZeroRange(0, 8)) return true;                                   // ::
  if (isZeroRange(0, 7) && g[7] === 1) return true;                     // ::1 loopback
  // IPv4-mapped ::ffff:0:0/96 (inclui a forma hexadecimal ::ffff:7f00:1)
  if (isZeroRange(0, 5) && g[5] === 0xffff) return isBlockedIpv4(ipv4FromGroups(g[6], g[7]));
  // IPv4-compatível ::/96 (obsoleto, mas ainda aceito por parsers)
  if (isZeroRange(0, 6)) return isBlockedIpv4(ipv4FromGroups(g[6], g[7]));
  // NAT64 64:ff9b::/96 — o IPv4 embutido decide
  if (g[0] === 0x64 && g[1] === 0xff9b && isZeroRange(2, 6)) {
    return isBlockedIpv4(ipv4FromGroups(g[6], g[7]));
  }
  // 6to4 2002::/16 — o IPv4 embutido decide
  if (g[0] === 0x2002) return isBlockedIpv4(ipv4FromGroups(g[1], g[2]));
  // Teredo 2001:0000::/32
  if (g[0] === 0x2001 && g[1] === 0x0000) return true;
  if ((g[0] & 0xfe00) === 0xfc00) return true;                          // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true;                          // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true;                          // site-local fec0::/10
  if ((g[0] & 0xff00) === 0xff00) return true;                          // multicast ff00::/8
  if (g[0] === 0x0100 && isZeroRange(1, 4)) return true;                // discard 100::/64
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                  // documentação 2001:db8::/32
  if (g[0] === 0x2001 && g[1] === 0x0002 && g[2] === 0x0000) return true; // benchmarking
  return false;
}

// IP literal privado/reservado (v4 e v6) — usado por hostname literal e pela
// validação DNS (mesma régua para os endereços resolvidos).
export function isPrivateIpLiteral(ip: string): boolean {
  const s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!s) return true;

  const dotted = parseIpv4(s);
  if (dotted) return isBlockedIpv4(dotted);

  const numeric = parseIpv4Numeric(s);
  if (numeric) return isBlockedIpv4(numeric);

  if (s.includes(':')) {
    const groups = parseIpv6(s);
    if (!groups) return true; // IPv6 malformado: bloqueia (fail-closed)
    return isBlockedIpv6(groups);
  }
  return true; // não é IP — bloqueia por conservadorismo
}

function isBlockedHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal' || h === 'metadata.goog') return true;
  // Literal IPv4 (inclusive decimal/octal/hexadecimal único) ou IPv6.
  if (/^[\d.]+$/.test(h) || /^0[xX][0-9a-f]+$/.test(h) || h.includes(':')) {
    return isPrivateIpLiteral(h);
  }
  return false;
}

// Um registro DNS só é avaliado se for IP reconhecível — IPv4 pontuado, IPv6
// ou IPv4 em formato numérico (defensivo: nunca confiar no formato).
function isIpLiteral(s: string): boolean {
  const t = String(s || '').trim();
  return !!parseIpv4(t) || !!parseIpv4Numeric(t) || t.includes(':');
}

// Cache curto de resoluções BEM-SUCEDIDAS (TTL 5 min): resolveDns no runtime
// mostrou flakiness transitória em chamadas em rajada (2026-10-17) — cachear
// o resultado seguro reduz o volume de consultas e mitiga a oscilação.
// Falhas NUNCA são cacheadas (fail-closed na próxima tentativa).
const dnsCache = new Map<string, { expires: number; ips: string[] }>();
const DNS_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveHostnameIps(hostname: string): Promise<{ ips: string[] | null; failed: boolean }> {
  const cached = dnsCache.get(hostname);
  if (cached && cached.expires > Date.now()) return { ips: cached.ips, failed: false };
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
    if (ips.length === 0) return { ips: null, failed: queryFailed };
    // Só cacheia se TODOS os IPs resolvidos forem públicos — um hostname
    // privado não deve ter a resolução aproveitada pelo cache.
    if (ips.some((ip) => isPrivateIpLiteral(ip))) return { ips, failed: false };
    dnsCache.set(hostname, { expires: Date.now() + DNS_CACHE_TTL_MS, ips });
    return { ips, failed: false };
  } catch {
    return { ips: null, failed: true };
  }
}

// Valida a RESOLUÇÃO do hostname (não só o texto). Retorna null se seguro ou
// um motivo de bloqueio. Fail-closed em qualquer falha da verificação.
// Nota de runtime (testado 2026-10-17): Deno.resolveDns inclui CNAMEs na
// resposta de 'A' — só os registros que são IP literal são avaliados; os IPs
// finais acompanham a cadeia. Consulta que falha (ENOTFOUND) → bloqueada.
async function dnsCheck(hostname: string): Promise<string | null> {
  if (!DNS_CHECK_ENABLED) return null;
  // 1ª tentativa + 1 retry (falha transitória do resolver observada em teste,
  // 2026-10-17) — IP privado/reservado bloqueia IMEDIATAMENTE, sem retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { ips, failed } = await resolveHostnameIps(hostname);
    if (ips === null) {
      if (!failed) return 'dns_unresolved'; // ENOTFOUND ou só CNAME — fail-closed
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 300)); continue; }
      return 'dns_check_failed'; // falha PERSISTENTE — fail-closed
    }
    for (const ip of ips) {
      if (isPrivateIpLiteral(ip)) return 'dns_private_ip';
    }
    return null;
  }
  return 'dns_check_failed';
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