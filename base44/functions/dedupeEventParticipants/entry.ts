import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { normalizeParticipantEmail } from "../../shared/participantDedup.ts";
// (dedup: 1 e-mail ativo = 1 inscrição por evento)
import { decUniqueParticipant, decParticipantsByRole } from "../../shared/businessMetrics.ts";

// Reconciliação única de duplicatas legadas de Participant (política: bloqueio
// com reativação — 1 e-mail ativo = 1 inscrição por evento).
//
// Para cada e-mail com MAIS DE UMA inscrição ativa no evento:
//   - mantém a inscrição mais antiga (pontos/histórico intactos);
//   - duplicatas SEM ingresso vinculado e SEM sessão como palestrante →
//     registration_status 'cancelled', sinalizadas no audit trail; os
//     contadores de métrica (unique_participants / participants_by_role) são
//     decrescidos — o registro duplo era double-count;
//   - duplicatas COM ingresso pago vinculado ou sessão associada NÃO são
//     canceladas automaticamente — listadas como conflitos para a gestão
//     resolver (ex.: estornar o ingresso excedente antes de cancelar).
//
// Idempotente: canceladas saem do conjunto ativo; reexecutar não muda nada.
// Payload: { eventId, dryRun? } — admin only.

const BATCH_SIZE = 500;

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    if (guard.user.role !== 'admin') {
      return Response.json({ error: 'Apenas administradores podem executar a deduplicação.' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { eventId, dryRun = false } = body;
    if (!eventId) return Response.json({ error: 'eventId obrigatório.' }, { status: 400 });

    const svc = base44.asServiceRole;
    const adminUser = guard.user;

    // Agrupa inscrições ativas por e-mail (paginação skip+limit, O(batch)).
    const byEmail = new Map<string, any[]>();
    let scanned = 0;
    let skip = 0;
    while (true) {
      const batch = await svc.entities.Participant.filter(
        { event_id: eventId, is_deleted: false, registration_status: { $ne: 'cancelled' } },
        'created_date', BATCH_SIZE, skip,
      );
      if (batch.length === 0) break;
      scanned += batch.length;
      for (const p of batch) {
        const key = normalizeParticipantEmail(p.email);
        if (!key) continue;
        if (!byEmail.has(key)) byEmail.set(key, []);
        byEmail.get(key).push(p);
      }
      skip += BATCH_SIZE;
      if (batch.length < BATCH_SIZE) break;
    }

    let groupsWithDuplicates = 0;
    let cancelled = 0;
    let conflicts = 0;
    const conflictList: any[] = [];

    for (const [email, recs] of byEmail) {
      if (recs.length < 2) continue;
      groupsWithDuplicates++;
      // Mantém a mais antiga; as demais são duplicatas.
      recs.sort((a: any, b: any) => new Date(a.created_date).getTime() - new Date(b.created_date).getTime());
      for (let d = 1; d < recs.length; d++) {
        const dup = recs[d];
        const [linkedTickets, linkedSessions] = await Promise.all([
          svc.entities.Ticket.filter({ participant_id: dup.id, is_deleted: false }),
          svc.entities.Session.filter({ event_id: eventId, speaker_id: dup.id, is_deleted: false }),
        ]);
        if (linkedTickets.length > 0 || linkedSessions.length > 0) {
          // Compra legada/dinheiro real ou papel ativo — resolução manual.
          conflicts++;
          if (conflictList.length < 100) {
            conflictList.push({
              participant_id: dup.id,
              email,
              name: dup.full_name,
              tickets: linkedTickets.length,
              sessions_as_speaker: linkedSessions.length,
            });
          }
          continue;
        }
        if (dryRun) { cancelled++; continue; }

        await svc.entities.Participant.update(dup.id, { registration_status: 'cancelled' });
        // Correção do double-count nas métricas do dia de criação da duplicata.
        try { await decUniqueParticipant(svc, eventId, dup.created_date); } catch {}
        try { await decParticipantsByRole(svc, eventId, dup.role_in_event || 'attendee', dup.created_date); } catch {}
        try {
          await svc.entities.AuditLog.create({
            action: 'status_change',
            entity_type: 'Participant',
            entity_id: dup.id,
            details: JSON.stringify({
              type: 'dedup_participante_cancelado',
              motivo: 'Duplicata por e-mail no mesmo evento — mantida a inscrição mais antiga (política: 1 e-mail ativo = 1 inscrição).',
              email,
              kept_participant_id: recs[0].id,
            }),
            event_id: eventId,
            user_id: adminUser.id,
            user_name: adminUser.full_name || adminUser.email || '',
          });
        } catch {}
        cancelled++;
      }
    }

    return Response.json({
      eventId,
      dryRun,
      scanned,
      groups_with_duplicates: groupsWithDuplicates,
      duplicates_cancelled: cancelled,
      conflicts_with_tickets_or_sessions: conflicts,
      conflicts: conflictList,
    });
  } catch (error: any) {
    console.error('[dedupeEventParticipants]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}