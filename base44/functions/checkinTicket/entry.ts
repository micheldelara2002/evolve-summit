import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

// Check-in de ingresso por QR (hash_code) ou ticket_id. Staff/admin/gerente.
// Marca Ticket.status='used', used_at; Participant.checkin_status='confirmed',
// checkin_at, checked_in_by_user_id. Idempotente: já 'used' retorna aviso.
// Rejeita cancelled/refunded.
//
// Payload: { code }  — hash_code do ingresso (do QR) ou ticket_id.
//
// ===== F4-01 (AUD-02) — SINCRONIZAÇÃO IDEMPOTENTE E REPARÁVEL DO PARTICIPANTE =====
//
// DEFEITO CORRIGIDO: o ingresso era marcado `used` por CAS e a atualização de
// `Participant` acontecia DEPOIS. Se aquela escrita falhasse, a resposta era
// erro — mas o retry encontrava o ingresso já `used` e retornava ANTES de
// sincronizar. Resultado: ingresso usado com participante pendente PARA SEMPRE
// (credenciamento e relatórios divergentes, sem caminho de reparo).
//
// Correção: a sincronização é uma função idempotente (CAS
// `checkin_status != confirmed` + confirmação por leitura) chamada nos DOIS
// caminhos — no check-in novo e no retry de um ingresso já usado (reparação).
// • Efeito idêntico ao anterior (checkin_status/checkin_at/checked_in_by_user_id):
//   nenhum contador, presença, ponto ou métrica é tocado, então reparar não
//   duplica efeito em relatórios.
// • Duas execuções concorrentes convergem para um único efeito (CAS).
// • O participante é SEMPRE lido com o `event_id` do ingresso: reparação nunca
//   alcança participante de outro evento.
// • O ingresso continua bloqueando entrada nova (`ok: false`, status 'used').

type ParticipantSync = {
  status: "sincronizado" | "divergente" | "falha_leitura" | "falha_escrita"
    | "participante_inexistente" | "participante_cancelado" | "sem_participante";
  repaired?: boolean;
  participant?: any;
};

async function syncParticipantCheckin(svc: any, ticket: any, user: any): Promise<ParticipantSync> {
  if (!ticket?.participant_id) return { status: "sem_participante" };

  let part: any = null;
  try {
    part = (await svc.entities.Participant.filter({ id: ticket.participant_id, event_id: ticket.event_id }))[0] || null;
  } catch (err: any) {
    console.error("[checkinTicket] leitura do participante falhou:", err?.message || err);
    return { status: "falha_leitura" };
  }
  if (!part) return { status: "participante_inexistente" };
  if (part.registration_status === "cancelled") return { status: "participante_cancelado", participant: part };
  if (part.checkin_status === "confirmed" && part.checkin_at) {
    return { status: "sincronizado", participant: part, repaired: false };
  }

  const stamp = ticket.used_at || new Date().toISOString();
  try {
    await svc.entities.Participant.updateMany(
      { id: part.id, event_id: ticket.event_id, checkin_status: { $ne: "confirmed" } },
      {
        $set: {
          checkin_status: "confirmed",
          checkin_at: part.checkin_at || stamp,
          checked_in_by_user_id: part.checked_in_by_user_id || user.id,
        },
      },
    );
  } catch (err: any) {
    console.error("[checkinTicket] sincronização do participante falhou:", err?.message || err);
    return { status: "falha_escrita" };
  }

  // Confirmação por LEITURA: a resposta do updateMany não é a autoridade.
  let fresh: any = null;
  try {
    fresh = (await svc.entities.Participant.filter({ id: part.id, event_id: ticket.event_id }))[0] || null;
  } catch (err: any) {
    console.error("[checkinTicket] confirmação da sincronização falhou:", err?.message || err);
    return { status: "falha_leitura" };
  }
  if (fresh && fresh.checkin_status === "confirmed") {
    return { status: "sincronizado", participant: fresh, repaired: true };
  }
  return { status: "divergente", participant: fresh };
}

// Trilha operacional do check-in (best-effort): registra falha e reparação.
async function writeCheckinTrail(svc: any, type: string, ticket: any, user: any, extra: Record<string, any> = {}) {
  try {
    await svc.entities.AuditLog.create({
      action: "status_change",
      entity_type: "Ticket",
      entity_id: ticket.id,
      details: JSON.stringify({ type, hash_code: ticket.hash_code, ...extra }),
      event_id: ticket.event_id,
      user_id: user.id,
    });
  } catch { /* a trilha não bloqueia o check-in */ }
}

function participantPayload(sync: ParticipantSync) {
  return sync.participant
    ? { id: sync.participant.id, checkin_status: sync.participant.checkin_status }
    : null;
}

// Resposta do caminho "ingresso já usado": a entrada continua bloqueada
// (`ok: false`). Se a sincronização do participante não pôde ser garantida, a
// resposta é 503 com `retry_sync` — a repetição conclui a reparação.
function duplicateCheckinResponse(sync: ParticipantSync, ticket: any, usedAt: any) {
  const syncFailed = sync.status === "falha_escrita" || sync.status === "falha_leitura" || sync.status === "divergente";
  const body = {
    ok: false,
    status: "used",
    holder_name: ticket.holder_name,
    used_at: usedAt,
    message: syncFailed
      ? "Ingresso já utilizado. A confirmação do participante ainda não foi concluída — repita a leitura para finalizar a sincronização."
      : "Ingresso já utilizado.",
    participant: participantPayload(sync),
    participant_sync: sync.status,
    repaired: sync.repaired === true,
  };
  return syncFailed
    ? Response.json({ ...body, retry_sync: true }, { status: 503 })
    : Response.json(body);
}

// Caminho do ingresso JÁ usado: verifica a sincronização e REPARA a divergência.
// Não valida entrada nova nem duplica efeito — apenas conclui o que faltou.
async function repairDuplicateCheckin(svc: any, ticket: any, user: any): Promise<ParticipantSync> {
  const sync = await syncParticipantCheckin(svc, ticket, user);
  if (sync.status === "sincronizado" && sync.repaired) {
    await writeCheckinTrail(svc, "ticket_checkin_repaired", ticket, user, {
      reason: "participante_sincronizado_apos_ingresso_used",
    });
  } else if (sync.status === "divergente" || sync.status === "falha_escrita" || sync.status === "falha_leitura") {
    await writeCheckinTrail(svc, "ticket_checkin_sync_failed", ticket, user, { reason: sync.status });
  }
  return sync;
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { code } = body;
    if (!code || typeof code !== 'string') {
      return Response.json({ error: 'Código do ingresso obrigatório.' }, { status: 400 });
    }
    const clean = code.trim();

    const svc = base44.asServiceRole;

    // Resolve por hash_code ou id (id só se for ObjectId válido).
    let tickets = await svc.entities.Ticket.filter({ hash_code: clean, is_deleted: false });
    if ((!tickets || tickets.length === 0) && /^[0-9a-f]{24}$/i.test(clean)) {
      tickets = await svc.entities.Ticket.filter({ id: clean, is_deleted: false });
    }
    const ticket = tickets?.[0];
    if (!ticket) return Response.json({ error: 'Ingresso não encontrado.', status: 'not_found' }, { status: 404 });

    // Autorização: staff/gerente do evento.
    const { authorized } = await verifyEventMembership(base44, user, ticket.event_id, EVENT_MANAGER_ROLES);
    if (!authorized && user.role !== 'admin') {
      return Response.json({ error: 'Sem permissão para check-in neste evento.' }, { status: 403 });
    }

    if (ticket.status === 'cancelled' || ticket.status === 'refunded') {
      return Response.json({
        ok: false,
        status: ticket.status,
        holder_name: ticket.holder_name,
        message: 'Ingresso cancelado/estornado — entrada bloqueada.',
      });
    }
    if (ticket.status === 'refund_pending') {
      return Response.json({
        ok: false,
        status: 'refund_pending',
        holder_name: ticket.holder_name,
        message: 'Estorno deste ingresso em andamento — entrada bloqueada.',
      });
    }
    if (ticket.status === 'used') {
      // F4-01 — ingresso já validado: verifica e, se divergente, REPARA a
      // sincronização do participante. A entrada continua bloqueada.
      const sync = await repairDuplicateCheckin(svc, ticket, user);
      return duplicateCheckinResponse(sync, ticket, ticket.used_at);
    }

    const now = new Date().toISOString();

    // SEC-003 — claim atômico: SOMENTE 'issued' pode virar 'used'. Elimina a
    // corrida entre scans concorrentes (nenhuma segunda confirmação/auditoria
    // e nenhuma dupla contagem de check-in) e a corrida com o estorno (o
    // check-in jamais sobrescreve 'refund_pending' por ler-then-write).
    const claim = await svc.entities.Ticket.updateMany(
      { id: ticket.id, status: 'issued' },
      { $set: { status: 'used', used_at: now } }
    );
    if (!claim || !claim.updated) {
      // Claim falhou — recarrega o estado autoritativo e responde corretamente.
      const fresh = (await svc.entities.Ticket.filter({ id: ticket.id, is_deleted: false }))[0] || ticket;
      if (fresh.status === 'used') {
        // F4-01 — perdeu o CAS para um check-in já confirmado: mesma reparação
        // idempotente do participante (entrada segue bloqueada).
        const sync = await repairDuplicateCheckin(svc, fresh, user);
        return duplicateCheckinResponse(sync, fresh, fresh.used_at);
      }
      if (fresh.status === 'refund_pending') {
        return Response.json({ ok: false, status: 'refund_pending', holder_name: fresh.holder_name, message: 'Estorno deste ingresso em andamento — entrada bloqueada.' });
      }
      if (fresh.status === 'cancelled' || fresh.status === 'refunded') {
        return Response.json({ ok: false, status: fresh.status, holder_name: fresh.holder_name, message: 'Ingresso cancelado/estornado — entrada bloqueada.' });
      }
      return Response.json({ ok: false, status: fresh.status, holder_name: fresh.holder_name, message: 'Ingresso mudou de estado — verifique e tente novamente.' }, { status: 409 });
    }

    // F4-01 — o ingresso JÁ está `used` (CAS acima). A sincronização é
    // idempotente; se falhar, a resposta é explícita (503 + retry_sync) e o
    // retry cai no caminho de reparação e conclui. Nunca fica ingresso usado
    // com participante pendente sem caminho de recuperação.
    let participantSync: ParticipantSync = { status: 'sem_participante' };
    if (ticket.participant_id) {
      participantSync = await syncParticipantCheckin(svc, { ...ticket, used_at: now }, user);
      if (participantSync.status === 'falha_escrita' || participantSync.status === 'falha_leitura' || participantSync.status === 'divergente') {
        await writeCheckinTrail(svc, 'ticket_checkin_sync_failed', ticket, user, { reason: participantSync.status });
        return Response.json({
          ok: false,
          status: 'used',
          holder_name: ticket.holder_name,
          ticket_type_name: ticket.ticket_type_name,
          used_at: now,
          message: 'Ingresso validado, mas a confirmação do participante não pôde ser concluída. Repita a leitura para finalizar a sincronização.',
          participant: participantPayload(participantSync),
          participant_sync: participantSync.status,
          retry_sync: true,
        }, { status: 503 });
      }
      if (participantSync.status === 'participante_inexistente' || participantSync.status === 'participante_cancelado') {
        // Sem participante válido neste evento: o ingresso segue válido e o caso
        // fica registrado para a gestão (nada é criado nem reparado).
        await writeCheckinTrail(svc, 'ticket_checkin_participant_unavailable', ticket, user, { reason: participantSync.status });
      }
    }

    // P2 (2026-09-29) — DEDUPE DE AUDITORIA na escrita: scanners sem sincronia
    // atômica de hardware podiam disparar a mesma confirmação em sequência
    // rápida e duplicar o AuditLog. Guarda de idempotência por (entidade+ação+
    // registro) em janela curta (5 min): se o log de checkin mais recente
    // deste ingresso já existe dentro da janela, não cria outro. O check-in em
    // si permanece idempotente pelo claim CAS acima — só o log é guardado.
    try {
      const recent = await svc.entities.AuditLog.filter(
        { entity_type: 'Ticket', entity_id: ticket.id, action: 'status_change' },
        '-created_date', 1
      );
      const last = recent?.[0];
      const isRecentCheckin = !!last && !!last.created_date &&
        (Date.now() - new Date(last.created_date).getTime()) < 5 * 60 * 1000 &&
        String(last.details || '').includes('ticket_checkin');
      if (!isRecentCheckin) {
        await svc.entities.AuditLog.create({
          action: 'status_change',
          entity_type: 'Ticket',
          entity_id: ticket.id,
          details: JSON.stringify({ type: 'ticket_checkin', hash_code: ticket.hash_code }),
          event_id: ticket.event_id,
          user_id: user.id,
        });
      }
    } catch {}

    return Response.json({
      ok: true,
      status: 'used',
      holder_name: ticket.holder_name,
      ticket_type_name: ticket.ticket_type_name,
      used_at: now,
      message: 'Check-in confirmado!',
      participant: participantPayload(participantSync),
      participant_sync: participantSync.status,
      repaired: participantSync.repaired === true,
    });
  } catch (error: any) {
    console.error('[checkinTicket]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}