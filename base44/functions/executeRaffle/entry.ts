import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES, canAccessPartnerData, verifyOwnSpeakerScope } from "../../shared/eventAuth.ts";

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { eventId, winnerCount, excludeIds = [], context, contextRefId } = await req.json();

    if (!eventId) {
      return Response.json({ error: 'eventId é obrigatório.' }, { status: 400 });
    }

    // Pool de elegíveis resolvido SEMPRE no servidor — o cliente nunca define
    // o universo do sorteio.
    let participants: any[];

    if (context === 'partner' && contextRefId) {
      // Sorteio de ESTANDE (2026-09-29): partner_manager OU representative do
      // parceiro sortea entre os PRÓPRIOS LEADS no evento — nunca o universo
      // de participantes. Gestão do evento (manager/team) também pode executar.
      const isMgmt = user.role === 'admin' ||
        (await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES)).authorized;
      if (!isMgmt) {
        const partnerOk = await canAccessPartnerData(base44, user, contextRefId);
        if (!partnerOk) {
          return Response.json({ error: 'Sem permissão para sortear para este parceiro.' }, { status: 403 });
        }
        const link = await svc.entities.EventPartner.filter({
          event_id: eventId, partner_id: contextRefId, is_active: true, is_deleted: false,
        });
        if (!link?.length) {
          return Response.json({ error: 'Parceiro não está ativo neste evento.' }, { status: 403 });
        }
      }
      const leads = await svc.entities.Lead.filter({ event_id: eventId, partner_id: contextRefId });
      const leadPartIds = [...new Set((leads || []).map((l: any) => l.participant_id).filter(Boolean))];
      if (leadPartIds.length === 0) {
        return Response.json({ error: 'Sem leads elegíveis disponíveis.' }, { status: 400 });
      }
      participants = await svc.entities.Participant.filter({
        id: { $in: leadPartIds },
        is_deleted: false,
        registration_status: { $ne: 'cancelled' },
      });
    } else if (context === 'speaker' && contextRefId) {
      // Sorteio do PALESTRANTE (2026-09-29): pool = presenças registradas
      // nas PRÓPRIAS sessões do palestrante — nunca o universo do evento.
      const isMgmt = user.role === 'admin' ||
        (await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES)).authorized;
      if (!isMgmt) {
        const ownScope = await verifyOwnSpeakerScope(base44, user, eventId, contextRefId);
        if (!ownScope) {
          return Response.json({ error: 'Sem permissão para sortear como palestrante neste evento.' }, { status: 403 });
        }
      }
      const sessions = await svc.entities.Session.filter({
        event_id: eventId, speaker_id: contextRefId, is_deleted: false,
      });
      const sessionIds = [...new Set((sessions || []).map((s: any) => s.id).filter(Boolean))];
      if (sessionIds.length === 0) {
        return Response.json({ error: 'Sem sessões elegíveis disponíveis.' }, { status: 400 });
      }
      const attendances = await svc.entities.SessionAttendance.filter({
        session_id: { $in: sessionIds },
      });
      const attPartIds = [...new Set(
        (attendances || []).filter((a: any) => a.is_present !== false)
          .map((a: any) => a.participant_id).filter(Boolean)
      )];
      if (attPartIds.length === 0) {
        return Response.json({ error: 'Sem presenças elegíveis disponíveis.' }, { status: 400 });
      }
      participants = await svc.entities.Participant.filter({
        id: { $in: attPartIds },
        is_deleted: false,
        registration_status: { $ne: 'cancelled' },
      });
    } else {
      // Sorteio do ORGANIZADOR: escopo de evento (manager/team/admin).
      const raffleAuth = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
      if (!raffleAuth.authorized) {
        return Response.json({ error: 'Sem permissão para realizar sorteios neste evento.' }, { status: 403 });
      }
      participants = await svc.entities.Participant.filter({
        event_id: eventId,
        is_deleted: false,
        registration_status: { $ne: 'cancelled' },
      });
    }

    if (!participants || participants.length === 0) {
      return Response.json({ error: 'Sem elegíveis disponíveis.' }, { status: 400 });
    }

    const pool = participants
      .map((p) => ({ id: p.id, full_name: p.full_name, email: p.email, company: p.company }))
      .filter((p) => p.id && !excludeIds.includes(p.id));

    if (pool.length === 0) {
      return Response.json({ error: 'Sem elegíveis disponíveis após exclusões.' }, { status: 400 });
    }

    const count = Math.max(1, parseInt(winnerCount) || 1);

    // Fisher-Yates shuffle com aleatoriedade criptograficamente segura
    const arr = [...pool];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = secureRandomInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }

    const winners = arr.slice(0, Math.min(count, arr.length)).map((p) => ({
      id: p.id,
      full_name: p.full_name,
      email: p.email,
      company: p.company,
      confirmed: false,
    }));

    return Response.json({ winners, drawnAt: new Date().toISOString() });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

/**
 * Gera inteiro aleatório [0, max) sem viés de módulo, usando Web Crypto API.
 */
function secureRandomInt(max) {
  const maxUint32 = 0xFFFFFFFF;
  const limit = maxUint32 - (maxUint32 % max);
  const buf = new Uint32Array(1);
  let val;
  do {
    crypto.getRandomValues(buf);
    val = buf[0];
  } while (val > limit);
  return val % max;
}