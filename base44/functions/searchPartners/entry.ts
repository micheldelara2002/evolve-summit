import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveUserPartnerManagerIds } from "../../shared/eventAuth.ts";
import { emailMatchVariants } from "../../shared/identity.ts";
import {
  normalizePartnerName,
  normalizeDocumentNumber,
  partnerSearchView,
} from "../../shared/partnerIdentity.ts";

// 2026-11-04 — BUSCA GLOBAL DE PARCEIRO (anti-duplicidade).
// O Partner é global e a RLS é admin-only, então quem gerencia evento precisa
// desta porta para responder "esse parceiro já existe?" antes de criar outro.
// Compara documento normalizado, nome normalizado (sem acento/sufixo) e e-mail,
// e informa em quais eventos o parceiro já está — a resposta à pergunta
// "eles vão saber que já existem em outro evento?".

const MAX_RESULTS = 12;

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;

    const body = await req.json().catch(() => ({}));
    const query = String(body.query || '').trim();
    const document = String(body.document || '').trim();
    const email = String(body.email || '').trim();
    const excludeId = String(body.excludeId || '');

    let allowed = user.role === 'admin';
    if (!allowed) {
      const [memberships, partnerManagerIds] = await Promise.all([
        svc.entities.EventMembership.filter({
          user_id: user.id,
          role: { $in: ['manager', 'team'] },
          is_active: true,
          is_deleted: false,
        }),
        resolveUserPartnerManagerIds(base44, user),
      ]);
      allowed = memberships.length > 0 || partnerManagerIds.length > 0;
    }
    if (!allowed) {
      return Response.json({ error: 'Sem permissão para consultar parceiros.' }, { status: 403 });
    }

    if (!query && !document && !email) {
      return Response.json({ partners: [] });
    }

    const found = new Map<string, any>();
    const matchedBy = new Map<string, string[]>();
    const remember = (partner: any, reason: string) => {
      if (!partner?.id || partner.is_deleted) return;
      if (excludeId && partner.id === excludeId) return;
      found.set(partner.id, partner);
      const list = matchedBy.get(partner.id) || [];
      if (!list.includes(reason)) list.push(reason);
      matchedBy.set(partner.id, list);
    };

    const docDigits = normalizeDocumentNumber(document);
    const nameKey = normalizePartnerName(query);
    const tasks: Promise<any>[] = [];

    if (docDigits) {
      tasks.push(
        (async () => {
          const rows = await svc.entities.Partner.filter({ is_deleted: false });
          for (const p of rows || []) {
            if (normalizeDocumentNumber(p.legal_document_number) === docDigits) remember(p, 'document');
          }
        })(),
      );
    }

    if (nameKey) {
      tasks.push(
        (async () => {
          const rows = await svc.entities.Partner.filter({ normalized_name: nameKey });
          for (const p of rows || []) remember(p, 'name');
        })(),
      );
      if (query.length >= 2) {
        tasks.push(
          (async () => {
            const rows = await svc.entities.Partner.filter({
              trade_name: { $regex: query, $options: 'i' },
              is_deleted: false,
            });
            for (const p of rows || []) remember(p, 'name_like');
          })(),
        );
        tasks.push(
          (async () => {
            const rows = await svc.entities.Partner.filter({
              legal_name: { $regex: query, $options: 'i' },
              is_deleted: false,
            });
            for (const p of rows || []) remember(p, 'name_like');
          })(),
        );
      }
    }

    if (email) {
      tasks.push(
        (async () => {
          const rows = await svc.entities.Partner.filter({ contact_email: { $in: emailMatchVariants(email) } });
          for (const p of rows || []) remember(p, 'email');
        })(),
      );
    }

    await Promise.all(tasks);

    const candidates = [...found.values()].slice(0, MAX_RESULTS);
    const withEvents = await Promise.all(
      candidates.map(async (p) => {
        const links = await svc.entities.EventPartner.filter({ partner_id: p.id, is_deleted: false });
        const eventIds = [...new Set((links || []).map((l: any) => l.event_id).filter(Boolean))];
        let event_names: string[] = [];
        if (eventIds.length) {
          const events = await svc.entities.Event.filter({ id: { $in: eventIds } });
          event_names = (events || []).map((e: any) => e.name).filter(Boolean);
        }
        return {
          ...partnerSearchView(p),
          event_count: eventIds.length,
          event_names,
          matched_by: matchedBy.get(p.id) || [],
        };
      }),
    );

    // Documento exato ou nome idêntico = correspondência forte (não é "parecido").
    const strong = withEvents.some(
      (p) => p.matched_by.includes('document') || p.matched_by.includes('name'),
    );

    return Response.json({
      partners: withEvents,
      exact_document_match: withEvents.some((p) => p.matched_by.includes('document')),
      strong_match: strong,
      normalized_name: nameKey,
    });
  } catch (error: any) {
    console.error('searchPartners error:', error?.message || error);
    return Response.json({ error: 'Não foi possível consultar parceiros.' }, { status: 500 });
  }
}