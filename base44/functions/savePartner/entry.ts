import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { canManagePartnerData } from "../../shared/eventAuth.ts";
import { sanitizeText } from "../../shared/sanitize.ts";
import { normalizeEmail } from "../../shared/identity.ts";
import { partnerIdentityFields, partnerIdentityKey, partnerSearchView } from "../../shared/partnerIdentity.ts";

// 2026-11-04 — O Partner é global e pode não ter CNPJ ("Agilistas de SP").
// A criação passa a aceitar identidade INFORMAL (nome normalizado) e a recusar
// duplicata por identity_key. Quando o nome já existe, o retorno 409 traz os
// candidatos para o gerente revisar e vincular o existente em vez de recriar.
// Criar empresa: admin OU quem gerencia algum evento (o parceiro é global, mas
// o vínculo com o evento continua sendo por evento).

async function isEventManagerAnywhere(svc: any, userId: string) {
  const memberships = await svc.entities.EventMembership.filter({
    user_id: userId,
    role: { $in: ['manager', 'team'] },
    is_active: true,
    is_deleted: false,
  });
  return memberships.length > 0;
}

function buildClean(payload: any) {
  const clean: any = {};
  if (payload.trade_name !== undefined) clean.trade_name = sanitizeText(payload.trade_name);
  if (payload.legal_name !== undefined) clean.legal_name = sanitizeText(payload.legal_name);
  if (payload.legal_country_code !== undefined) clean.legal_country_code = payload.legal_country_code || 'BR';
  if (payload.legal_document_type !== undefined) clean.legal_document_type = payload.legal_document_type || 'CNPJ';
  if (payload.legal_document_number !== undefined) clean.legal_document_number = (payload.legal_document_number || '').trim();
  if (payload.identity_mode !== undefined) clean.identity_mode = payload.identity_mode === 'informal' ? 'informal' : 'formal';
  if (payload.contact_email !== undefined) clean.contact_email = normalizeEmail(payload.contact_email);
  if (payload.contact_phone !== undefined) clean.contact_phone = (payload.contact_phone || '').trim();
  if (payload.website !== undefined) clean.website = (payload.website || '').trim();
  if (payload.about !== undefined) clean.about = sanitizeText(payload.about || '');
  if (payload.logo_url !== undefined) clean.logo_url = payload.logo_url || '';
  if (payload.is_active !== undefined) clean.is_active = !!payload.is_active;
  return clean;
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;

    const body = await req.json().catch(() => ({}));
    const { id, action, payload } = body;

    // DELETE — admin only
    if (action === 'delete' && id) {
      if (user.role !== 'admin') return Response.json({ error: 'Apenas administradores podem remover empresas.' }, { status: 403 });
      const list = await svc.entities.Partner.filter({ id, is_deleted: false });
      if (!list?.[0]) return Response.json({ error: 'Empresa não encontrada.' }, { status: 404 });
      await svc.entities.Partner.update(id, { is_deleted: true });
      return Response.json({ ok: true, id });
    }

    // UPDATE — admin OR partner_manager do parceiro
    if (id) {
      const ok = await canManagePartnerData(base44, user, id);
      if (!ok) return Response.json({ error: 'Sem permissão para editar esta empresa.' }, { status: 403 });

      const currentRows = await svc.entities.Partner.filter({ id });
      const current = currentRows?.[0];
      if (!current) return Response.json({ error: 'Empresa não encontrada.' }, { status: 404 });

      const clean = buildClean(payload || {});
      const merged = { ...current, ...clean };
      const identity = partnerIdentityFields(merged);

      if (identity.identity_key && identity.identity_key !== current.identity_key) {
        const dupes = await svc.entities.Partner.filter({ identity_key: identity.identity_key, is_deleted: false });
        const conflict = (dupes || []).find((p: any) => p.id !== id);
        if (conflict) {
          return Response.json({
            error: `Já existe um parceiro com esta identidade: ${conflict.trade_name}. Vincule o existente em vez de criar outro.`,
            duplicates: [partnerSearchView(conflict)],
          }, { status: 409 });
        }
      }

      await svc.entities.Partner.update(id, { ...clean, ...identity });
      return Response.json({ ok: true, id });
    }

    // CREATE — admin OR quem gerencia algum evento
    let allowed = user.role === 'admin';
    if (!allowed) allowed = await isEventManagerAnywhere(svc, user.id);
    if (!allowed) {
      return Response.json({ error: 'Apenas administradores ou gerentes de evento podem cadastrar empresas.' }, { status: 403 });
    }

    const p = payload || {};
    const mode = p.identity_mode === 'informal' ? 'informal' : 'formal';
    const tradeName = sanitizeText(p.trade_name || '');
    const legalName = sanitizeText(p.legal_name || (mode === 'informal' ? p.trade_name : ''));
    const documentNumber = (p.legal_document_number || '').trim();

    if (!tradeName) {
      return Response.json({ error: 'Informe o nome do parceiro.' }, { status: 400 });
    }
    if (mode === 'formal' && (!legalName || !documentNumber)) {
      return Response.json({ error: 'Razão social e documento são obrigatórios para parceiros com CNPJ. Para coletivos e pessoas físicas, marque "sem documento".' }, { status: 400 });
    }

    const candidate = {
      trade_name: tradeName,
      legal_name: legalName || tradeName,
      legal_country_code: p.legal_country_code || 'BR',
      legal_document_type: mode === 'informal' ? 'NONE' : (p.legal_document_type || 'CNPJ'),
      legal_document_number: documentNumber,
      identity_mode: mode,
    };
    const identity = partnerIdentityFields(candidate);
    const identityKey = partnerIdentityKey(candidate);

    if (identityKey) {
      const dupes = await svc.entities.Partner.filter({ identity_key: identityKey, is_deleted: false });
      const conflict = dupes?.[0];
      if (conflict) {
        return Response.json({
          error: mode === 'informal'
            ? `Já existe um parceiro com este nome: ${conflict.trade_name}. Vincule o cadastro existente ao evento.`
            : `Documento já cadastrado para: ${conflict.trade_name}. Vincule o parceiro existente ao evento.`,
          duplicates: [partnerSearchView(conflict)],
        }, { status: 409 });
      }
    }

    const created = await svc.entities.Partner.create({
      ...candidate,
      ...identity,
      contact_email: normalizeEmail(p.contact_email),
      contact_phone: (p.contact_phone || '').trim(),
      website: (p.website || '').trim(),
      about: sanitizeText(p.about || ''),
      logo_url: p.logo_url || '',
      is_active: p.is_active !== false,
      created_day: new Date().toISOString().slice(0, 10),
      is_deleted: false,
    });

    return Response.json({
      ok: true,
      id: created.id,
      created_date: created.created_date,
      identity_key: created.identity_key,
    });
  } catch (error: any) {
    console.error('savePartner error:', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}