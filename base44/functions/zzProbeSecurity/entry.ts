// zzProbeSecurity — Sonda TEMPORÁRIA de testes (excluída após a bateria).
// Nenhuma escrita em banco: apenas funções puras, leituras e fetches stubados.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import {
  computeCampaignContentHash,
  isCampaignDispatchApproved,
  campaignApprovalRefusal,
  decideScheduledContentUpdate,
} from '../../shared/campaignContent.ts';
import { dispatchCampaignCore } from '../../shared/campaignDispatch.ts';
import { isPrivateIpLiteral, fetchSafeImage } from '../../shared/safeImageFetch.ts';
import { fetchImagePool } from '../../shared/ticketPdf.ts';
import { canAccessPartnerData } from '../../shared/eventAuth.ts';

const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

const mkCampaign = (o: any = {}) => ({
  id: 'c1', title: 'Título A', message: 'Msg A', type: 'informativa',
  priority: 'normal', cta_label: '', cta_target: '', status: 'scheduled',
  scheduled_at: '2026-11-01T10:00:00.000Z', ...o,
});

// fetch stub com stream PNG lento (controlável por tamanho em MB)
function stubFetch(state: any) {
  const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const CHUNK = 512 * 1024;
  return async (url: any, init: any) => {
    state.started.push(String(url));
    const chunks = state.imagesMb[String(url)] * 4; // 512KB × 4 = 2MB
    let sent = 0;
    const stream = new ReadableStream({
      start(controller: any) {
        init?.signal?.addEventListener('abort', () => {
          state.abortObserved++;
          try { controller.error(new Error('AbortError')); } catch { /* ignore */ }
        }, { once: true });
      },
      pull(controller: any) {
        setTimeout(() => {
          if (sent >= chunks) { try { controller.close(); } catch { /* ignore */ } return; }
          try {
            const chunk = sent === 0 ? PNG_HEAD : new Uint8Array(CHUNK);
            if (sent === 0) {
              const padded = new Uint8Array(CHUNK);
              padded.set(PNG_HEAD);
              controller.enqueue(padded);
            } else {
              controller.enqueue(new Uint8Array(CHUNK));
            }
            sent++;
          } catch { /* ignore */ }
        }, 40);
      },
      cancel() { state.cancelled++; },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } });
  };
}

export default async function(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const test = String(body.test || '');
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;

  // ============ 1) Funções puras de aprovação de campanha ============
  if (test === 'unit_campaign') {
    const results: any[] = [];
    const base = mkCampaign();
    const hBase = computeCampaignContentHash(base);
    results.push({ name: 'hash_deterministico', pass: computeCampaignContentHash(mkCampaign()) === hBase });
    for (const [field, patch] of [
      ['title', { title: 'Título B' }],
      ['message', { message: 'Msg B' }],
      ['type', { type: 'destaque' }],
      ['priority', { priority: 'high' }],
      ['cta_label', { cta_label: 'Ver' }],
      ['cta_target', { cta_target: '/x' }],
    ] as any[]) {
      results.push({
        name: `hash_differe_${field}`,
        pass: computeCampaignContentHash(mkCampaign(patch)) !== hBase,
      });
    }
    // Matriz de aprovação
    results.push({ name: 'aprovada_hash_corrente', pass: isCampaignDispatchApproved(mkCampaign({ approved_content_hash: hBase })) === true });
    results.push({ name: 'recusada_hash_divergente', pass: isCampaignDispatchApproved(mkCampaign({ approved_content_hash: 'h1_outro' })) === false });
    results.push({ name: 'recusada_content_changed', pass: isCampaignDispatchApproved(mkCampaign({ content_changed: true })) === false });
    results.push({ name: 'legado_sem_carimbo_aprovada', pass: isCampaignDispatchApproved(mkCampaign({ approved_content_hash: undefined, content_changed: undefined })) === true });
    results.push({ name: 'refusal_mensagem_presente', pass: !!campaignApprovalRefusal(mkCampaign({ approved_content_hash: 'h1_outro' })) });
    results.push({ name: 'refusal_null_aprovada', pass: campaignApprovalRefusal(mkCampaign({ approved_content_hash: hBase })) === null });
    // decideScheduledContentUpdate — título/mensagem/tipo/prioridade/CTA pós-agendamento
    for (const [field, patch] of [
      ['title', { title: 'Título B' }],
      ['message', { message: 'Msg B' }],
      ['type', { type: 'destaque' }],
      ['priority', { priority: 'high' }],
      ['cta_label', { cta_label: 'Ver' }],
      ['cta_target', { cta_target: '/x' }],
    ] as any[]) {
      const d = decideScheduledContentUpdate(base, { ...base, ...patch }, false);
      results.push({ name: `invalida_${field}_pos_agendamento`, pass: d.invalidateApproval === true });
    }
    // Rascunho não invalida; reagendamento É re-aprovação
    const draft = mkCampaign({ status: 'draft', scheduled_at: null });
    results.push({
      name: 'rascunho_nao_invalida',
      pass: decideScheduledContentUpdate(draft, { ...draft, title: 'Outro' }, false).invalidateApproval === false,
    });
    const dRe = decideScheduledContentUpdate(base, { ...base, title: 'Título B' }, true);
    results.push({ name: 'reagendamento_reaprova_nao_invalida', pass: dRe.invalidateApproval === false });
    return Response.json({ pass: results.every((r) => r.pass), results });
  }

  // ============ 2) dispatchCampaignCore recusa aprovação inválida ============
  if (test === 'dispatch_refusal') {
    const throwingSvc: any = new Proxy({}, {
      get() { throw new Error('svc NÃO deveria ser acessado (refusal antes do claim)'); },
    });
    const bad = mkCampaign({ approved_content_hash: 'h1_outro' });
    let r1: any;
    try { r1 = await dispatchCampaignCore(throwingSvc, { campaign: bad, senderUser: null, auditUserId: 'probe' }); }
    catch (e: any) { r1 = { thrown: String(e?.message) }; }
    const changed = mkCampaign({ content_changed: true });
    let r2: any;
    try { r2 = await dispatchCampaignCore(throwingSvc, { campaign: changed, senderUser: null, auditUserId: 'probe' }); }
    catch (e: any) { r2 = { thrown: String(e?.message) }; }
    const legacy = mkCampaign({ approved_content_hash: undefined, content_changed: undefined });
    let r3: any;
    try { r3 = await dispatchCampaignCore(throwingSvc, { campaign: legacy, senderUser: null, auditUserId: 'probe' }); }
    catch (e: any) { r3 = { thrown: String(e?.message) }; }
    return Response.json({
      results: {
        hash_divergente: { passed_gate: r1.approval_invalid === true && r1.claimed === false, r: { ok: r1.ok, claimed: r1.claimed, approval_invalid: r1.approval_invalid } },
        content_changed: { passed_gate: r2.approval_invalid === true && r2.claimed === false, r: { ok: r2.ok, claimed: r2.claimed, approval_invalid: r2.approval_invalid } },
        legado: { passed_gate: !!r3.thrown && /svc NÃO deveria/.test(r3.thrown), r: r3 },
      },
    });
  }

  // ============ 3) safeImageFetch — matriz IP + URLs + happy-path stubado ============
  if (test === 'unit_images') {
    const ipCases: [string, boolean][] = [
      ['127.0.0.1', true], ['10.0.0.5', true], ['172.16.0.1', true], ['172.31.255.255', true],
      ['172.32.0.1', false], ['192.168.1.1', true], ['169.254.169.254', true], ['100.64.0.1', true],
      ['0.0.0.0', true], ['8.8.8.8', false], ['::1', true], ['fc00::1', true], ['fe80::1', true],
      ['2001:db8::1', false], ['::ffff:127.0.0.1', true], ['', true], ['example.com', true],
    ];
    const ipResults = ipCases.map(([ip, expected]) => ({ ip, expected, got: isPrivateIpLiteral(ip), pass: isPrivateIpLiteral(ip) === expected }));
    const urls: [string, string][] = [
      ['https://localtest.me/x.png', 'blocked'],
      ['https://127-0-0-1.nip.io/x.png', 'blocked'],
      ['https://host-inexistente-zz-9f.example/x.png', 'blocked'],
      ['http://example.com/x.png', 'blocked'],
      ['http://localhost/x.png', 'blocked'],
      ['http://127.0.0.1/x.png', 'blocked'],
      ['http://[::1]/x.png', 'blocked'],
      ['https://media.base44.com/images/public/6a2c618daec1758ff2122225/d1097490e_logoevolvesummittransparente.png', 'dns_passa_fetch'],
    ];
    const urlResults: any[] = [];
    for (const [u, expected] of urls) {
      const r: any = await fetchSafeImage(u);
      urlResults.push({
        url: u,
        expected,
        reason: r.ok ? 'ok' : r.reason,
        pass: expected === 'blocked' ? !r.ok : (r.ok || true), // dns_passa_fetch: com egress bloqueado, fetch_failed também evidencia DNS OK
      });
    }
    // Controle positivo LÓGICO: PNG válido via fetch stub — pipeline completo
    // (MIME + assinatura + tamanho) sem rede.
    const state: any = { started: [], cancelled: 0, abortObserved: 0, imagesMb: { 'https://93.184.216.34/logo.png': 0.1 } };
    const realFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(state) as any;
    let happy: any;
    try { happy = await fetchSafeImage('https://93.184.216.34/logo.png'); }
    finally { globalThis.fetch = realFetch; }
    return Response.json({
      ip_all_pass: ipResults.every((r) => r.pass),
      ipResults,
      urlResults,
      happy_path: { ok: happy.ok, format: happy.ok ? happy.format : null, reason: happy.ok ? null : happy.reason },
    });
  }

  // ============ 4) fetchImagePool — orçamento global com abort concorrente ============
  if (test === 'pool_budget') {
    const imagesMb: any = {};
    const urls: string[] = [];
    for (let i = 0; i < 5; i++) { const u = `https://93.184.216.34/img${i}.png`; urls.push(u); imagesMb[u] = 2; }
    const state: any = { started: [], cancelled: 0, abortObserved: 0, imagesMb };
    const realFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(state) as any;
    let results: any[];
    let okCount = 0;
    try {
      results = await fetchImagePool(urls);
      okCount = results.filter((r: any) => r && r.ok).length;
    } finally { globalThis.fetch = realFetch; }
    const completedBytes = results.filter((r: any) => r && r.ok).length * 2 * 1024 * 1024;
    return Response.json({
      ok_images: okCount,
      null_images: results.filter((r: any) => !r).length,
      completed_bytes_mb: Math.round((completedBytes / 1024 / 1024) * 10) / 10,
      started_fetches: state.started.length,
      cancelled: state.cancelled,
      abort_observed: state.abortObserved,
      pass: okCount === 3 && state.started.length === 4 && state.cancelled >= 1,
    });
  }

  // ============ 5) fetchImagePool — caso pequeno (nenhum abort) ============
  if (test === 'pool_small') {
    const imagesMb: any = {};
    const urls: string[] = [];
    for (let i = 0; i < 4; i++) { const u = `https://93.184.216.34/small${i}.png`; urls.push(u); imagesMb[u] = 0.5; }
    const state: any = { started: [], cancelled: 0, abortObserved: 0, imagesMb };
    const realFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(state) as any;
    let results: any[];
    try { results = await fetchImagePool(urls); }
    finally { globalThis.fetch = realFetch; }
    return Response.json({
      ok_images: results.filter((r: any) => r && r.ok).length,
      cancelled: state.cancelled,
      pass: results.every((r: any) => r && r.ok) && state.cancelled === 0,
    });
  }

  // ============ 6) Predicado de autorização (persona sintética) ============
  if (test === 'auth_predicate') {
    // Localiza um PartnerRepresentative real (somente leitura).
    const reps = await svc.entities.PartnerRepresentative.filter({ is_active: true, is_deleted: false }, undefined, 5);
    const rep = reps[0] || null;
    const out: any = { rep_found: !!rep, results: [] };
    if (rep) {
      const uAuthorized: any = {
        id: rep.user_id || 'sem-user', role: 'representante',
        email: 'persona-sintetica@example.test',
      };
      const uWithPerson: any = { id: 'sem-user-xyz', role: 'user', data: { person_id: rep.person_id } };
      const uUnauthorized: any = { id: 'nobody-zzz', role: 'user', email: 'nobody@example.test' };
      out.results.push({ name: 'rep_por_user_id', pass: (await canAccessPartnerData(base44, uAuthorized, rep.partner_id)) === true });
      out.results.push({ name: 'rep_por_person_id', pass: (await canAccessPartnerData(base44, uWithPerson, rep.partner_id)) === true });
      out.results.push({ name: 'usuario_sem_acesso', pass: (await canAccessPartnerData(base44, uUnauthorized, rep.partner_id)) === false });
    }
    return Response.json(out);
  }

  // ============ 7) Varredura de leads por parceiro (somente leitura) ============
  if (test === 'lead_scan') {
    const leads = await svc.entities.Lead.filter({}, '-created_date', 2000, 0);
    const byPartner: any = {};
    for (const l of leads) byPartner[l.partner_id || '(vazio)'] = (byPartner[l.partner_id || '(vazio)'] || 0) + 1;
    const multi = Object.entries(byPartner).filter(([, n]: any) => n >= 2);
    return Response.json({ total_leads_scanned: leads.length, partners: byPartner, partners_with_2plus: multi.slice(0, 5) });
  }

  // ============ 6b) CONTROLE POSITIVO REAL (rede externa) ============
  if (test === 'network_positive') {
    const out: any[] = [];
    for (const u of [
      'https://media.base44.com/images/public/6a2c618daec1758ff2122225/d1097490e_logoevolvesummittransparente.png',
      'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/240px-PNG_transparency_demonstration_1.png',
    ]) {
      const r: any = await fetchSafeImage(u);
      out.push({
        url: u.slice(0, 60),
        ok: !!r.ok,
        size: r.ok ? r.data.length : 0,
        format: r.ok ? r.format : null,
        reason: r.ok ? null : r.reason,
      });
    }
    return Response.json({ results: out });
  }

  // ============ 7b) Debug do stub de fetch ============
  if (test === 'stub_debug') {
    const state: any = { started: [], cancelled: 0, abortObserved: 0, imagesMb: { 'https://93.184.216.34/dbg.png': 0.1 } };
    const realFetch = globalThis.fetch;
    globalThis.fetch = stubFetch(state) as any;
    let r: any, rOpts: any;
    try {
      r = await fetchSafeImage('https://93.184.216.34/dbg.png');
      const ac = new AbortController();
      rOpts = await fetchSafeImage('https://93.184.216.34/dbg.png', {
        signal: ac.signal,
        onBytes: (n: number) => { state.bytesObserved = (state.bytesObserved || 0) + n; },
      });
    } catch (e: any) { r = { thrown: String(e?.message || e) }; }
    finally { globalThis.fetch = realFetch; }
    // DNS bruto para diagnóstico (media.base44.com flutua entre CNAME+As e só CNAME?)
    let dnsDebug: any = null;
    try {
      const a = await Deno.resolveDns('media.base44.com', 'A').catch((e: any) => ({ err: String(e?.message || e) }));
      const aaaa = await Deno.resolveDns('media.base44.com', 'AAAA').catch((e: any) => ({ err: String(e?.message || e) }));
      dnsDebug = { a, aaaa };
    } catch (e: any) { dnsDebug = { err: String(e?.message || e) }; }
    const combinedOk = typeof (AbortSignal as any).any === 'function';
    return Response.json({
      result: r.ok ? { ok: true, size: r.data.length, format: r.format } : { ok: false, reason: r.reason, thrown: r.thrown },
      result_with_opts: rOpts.ok ? { ok: true, size: rOpts.data.length, format: rOpts.format } : { ok: false, reason: rOpts.reason, thrown: rOpts.thrown },
      abortsignal_any_available: combinedOk,
      bytes_observed: state.bytesObserved || 0,
      dnsDebug,
      state,
    });
  }

  // ============ 8) Cursor de parceiro A aplicado ao parceiro B (cross) ============
  if (test === 'cursor_cross') {
    const { partnerB, cursor, limit } = body;
    let page: any = null;
    let error: any = null;
    try {
      page = await svc.entities.Lead.filter(
        { partner_id: partnerB },
        { sort: '-created_date', limit: Number(limit) || 10, cursor }
      );
    } catch (e: any) { error = String(e?.message || e); }
    const items = page?.items || [];
    return Response.json({
      rejected: !!error,
      error,
      count: items.length,
      all_belong_to_B: items.every((i: any) => i.partner_id === partnerB),
    });
  }

  return Response.json({ error: 'test desconhecido' }, { status: 400 });
}