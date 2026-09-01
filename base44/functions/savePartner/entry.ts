import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { canManagePartnerData } from "../../shared/eventAuth.ts";

function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/<[^>]*>/g, '').replace(/javascript:/gi, '').replace(/on\w+\s*=/gi, '').trim();
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json();
    const { id, action, payload } = body;

    // DELETE — admin only
    if (action === 'delete' && id) {
      if (user.role !== 'admin') return Response.json({ error: 'Apenas administradores podem remover empresas.' }, { status: 403 });
      const list = await base44.asServiceRole.entities.Partner.filter({ id, is_deleted: false });
      if (!list?.[0]) return Response.json({ error: 'Empresa não encontrada.' }, { status: 404 });
      await base44.asServiceRole.entities.Partner.update(id, { is_deleted: true });
      return Response.json({ ok: true, id });
    }

    // UPDATE — admin OR partner_manager do parceiro
    if (id) {
      const ok = await canManagePartnerData(base44, user, id);
      if (!ok) return Response.json({ error: 'Sem permissão para editar esta empresa.' }, { status: 403 });
      const p = payload || {};
      const clean = {};
      if (p.trade_name !== undefined) clean.trade_name = sanitizeText(p.trade_name);
      if (p.legal_name !== undefined) clean.legal_name = sanitizeText(p.legal_name);
      if (p.legal_country_code !== undefined) clean.legal_country_code = p.legal_country_code;
      if (p.legal_document_type !== undefined) clean.legal_document_type = p.legal_document_type;
      if (p.legal_document_number !== undefined) clean.legal_document_number = (p.legal_document_number || '').trim();
      if (p.contact_email !== undefined) clean.contact_email = (p.contact_email || '').trim();
      if (p.contact_phone !== undefined) clean.contact_phone = (p.contact_phone || '').trim();
      if (p.website !== undefined) clean.website = (p.website || '').trim();
      if (p.about !== undefined) clean.about = sanitizeText(p.about || '');
      if (p.logo_url !== undefined) clean.logo_url = p.logo_url || '';
      if (p.is_active !== undefined) clean.is_active = !!p.is_active;
      await base44.asServiceRole.entities.Partner.update(id, clean);
      return Response.json({ ok: true, id });
    }

    // CREATE — admin only
    if (user.role !== 'admin') return Response.json({ error: 'Apenas administradores podem criar empresas.' }, { status: 403 });
    const p = payload || {};
    if (!p.trade_name || !p.legal_name || !p.legal_document_number) {
      return Response.json({ error: 'Nome comercial, razão social e documento são obrigatórios.' }, { status: 400 });
    }
    const created = await base44.asServiceRole.entities.Partner.create({
      trade_name: sanitizeText(p.trade_name),
      legal_name: sanitizeText(p.legal_name),
      legal_country_code: p.legal_country_code || 'BR',
      legal_document_type: p.legal_document_type || 'CNPJ',
      legal_document_number: (p.legal_document_number || '').trim(),
      contact_email: (p.contact_email || '').trim(),
      contact_phone: (p.contact_phone || '').trim(),
      website: (p.website || '').trim(),
      about: sanitizeText(p.about || ''),
      logo_url: p.logo_url || '',
      is_active: p.is_active !== false,
      created_day: new Date().toISOString().slice(0, 10),
    });
    return Response.json({ ok: true, id: created.id, created_date: created.created_date });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});