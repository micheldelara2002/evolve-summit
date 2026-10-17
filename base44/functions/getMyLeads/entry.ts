import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { canAccessPartnerData } from "../../shared/eventAuth.ts";

// Lote 3 — Leads de um parceiro (leitura autorizada).
// Valida que o chamador é admin OU PartnerRepresentative ativo do partnerId
// (qualquer role_in_partner — managers e representatives leem leads).
// eventId opcional: filtra leads de um evento específico; sem ele, todos os
// eventos (uso legítimo do dashboard do parceiro — a autorização cobre o
// parceiro inteiro).
//
// P0 (2026-10-17) — Paginação por CURSOR + minimização de dados:
//   - Até 200 registros por chamada (limite do cliente é normalizado; padrão 100).
//   - Cursor opaco do backend (sort estável '-created_date'); o cliente nunca
//     constrói/altera o cursor — ele só repassa o next_cursor devolvido.
//   - Apenas os campos usados pelas telas (sem person_phone/linkedin/company/
//     job_title, participant_id interno de pessoa, created_day, etc.).
//
// Payload: { partnerId, eventId?, limit?, cursor? }

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const LEAD_FIELDS = [
  'id', 'event_id', 'participant_id', 'participant_name', 'participant_email',
  'source', 'quality', 'notes', 'visited_at', 'created_date',
];

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { partnerId, eventId } = body;
    if (!partnerId) return Response.json({ error: 'partnerId obrigatório.' }, { status: 400 });

    const ok = await canAccessPartnerData(base44, user, partnerId);
    if (!ok) return Response.json({ error: 'Sem permissão para acessar leads deste parceiro.' }, { status: 403 });

    // Limite normalizado: ausente/negativo/inválido → padrão; acima do máximo
    // → máximo (o cliente nunca excede o teto).
    let limit = Number(body.limit);
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
    limit = Math.min(Math.floor(limit), MAX_LIMIT);

    const cursor = typeof body.cursor === 'string' && body.cursor ? body.cursor : undefined;

    const svc = base44.asServiceRole;
    const filter: any = { partner_id: partnerId };
    if (eventId) filter.event_id = eventId;

    // Uma página por chamada — nunca 10k registros numa resposta.
    const page = await svc.entities.Lead.filter(
      filter,
      { sort: '-created_date', limit, cursor, fields: LEAD_FIELDS }
    );

    // Contagem exata server-side (badge do dashboard/tela sem carregar tudo).
    const total = await svc.entities.Lead.count(filter);

    return Response.json({
      leads: page.items || [],
      next_cursor: page.next_cursor || null,
      has_more: !!page.has_more,
      total,
    });
  } catch (error: any) {
    console.error('[getMyLeads]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}