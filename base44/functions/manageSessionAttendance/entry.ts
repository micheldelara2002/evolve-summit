// manageSessionAttendance — Lote 4. Presença em sessão movida para o servidor.
//   action='status'    → consulta isPresent do chamador na sessão
//   action='register'  → dedupe + checagem de capacidade + create + Lead (sessão com palestrante)
//   action='unregister' → marca is_present=false
// Autorização: o participante é do próprio chamador (email/person_id), admin,
// ou gestor do evento. Contadores de leads (sessão) incrementados aqui.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { requireActiveUser } from '../../shared/accountSecurity.ts';
import { resolveUserPersonId, verifyEventMembership, EVENT_MANAGER_ROLES } from '../../shared/eventAuth.ts';
import { validIds } from '../../shared/idGuard.ts';
import { incLeads } from '../../shared/businessMetrics.ts';
import { deterministicCompare } from '../../shared/deterministicSurvivor.ts';

// Item 2 (2026-10-09) — Backfill lazy do gate de capacidade para sessões
// legadas sem o campo presence_count. CAS sobre o valor atual ({presence_count:
// null} casa com campo AUSENTE no MongoDB): corrida de backfills resolve em
// exatamente um vencedor. Seguro extra: presence_count=0 com presenças já
// existentes é tratado como drift (default retroativo) e reconduzido.
async function ensurePresenceCount(svc: any, sessionId: string) {
  const load = async () => (await svc.entities.Session.filter({ id: sessionId }))[0];
  let session = await load();
  if (!session) return null;
  const pc = session.presence_count;
  if (pc === undefined || pc === null) {
    const all = await svc.entities.SessionAttendance.filter({ session_id: sessionId, is_present: true });
    const claimed = await svc.entities.Session.updateMany(
      { id: sessionId, presence_count: null },
      { $set: { presence_count: (all || []).length } }
    );
    if (claimed && claimed.updated) session.presence_count = (all || []).length;
    else session = await load();
  } else if (pc === 0) {
    const sample = await svc.entities.SessionAttendance.filter({ session_id: sessionId, is_present: true }, 'id', 1);
    if ((sample || []).length > 0) {
      const all = await svc.entities.SessionAttendance.filter({ session_id: sessionId, is_present: true });
      const claimed = await svc.entities.Session.updateMany(
        { id: sessionId, presence_count: 0 },
        { $set: { presence_count: (all || []).length } }
      );
      if (claimed && claimed.updated) session.presence_count = (all || []).length;
      else session = await load();
    }
  }
  return session;
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    // SEC-004 — guard de conta ativa: conta excluída com token válido é bloqueada.
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const sessionId = body.sessionId;
    const participantId = body.participantId;
    const action = String(body.action || '');
    if (!sessionId || !participantId || !action) {
      return Response.json({ error: 'sessionId, participantId e action são obrigatórios.' }, { status: 400 });
    }
    if (!validIds([sessionId]).length || !validIds([participantId]).length) {
      return Response.json({ error: 'Sessão ou participante não encontrado.' }, { status: 404 });
    }
    if (!['status', 'register', 'unregister'].includes(action)) {
      return Response.json({ error: 'Ação inválida.' }, { status: 400 });
    }

    const svc = base44.asServiceRole;
    const sessions = await svc.entities.Session.filter({ id: sessionId, is_deleted: false });
    const session = sessions[0];
    if (!session) return Response.json({ error: 'Sessão não encontrada.' }, { status: 404 });

    const participants = await svc.entities.Participant.filter({
      id: participantId,
      event_id: session.event_id,
      is_deleted: false,
    });
    const participant = participants[0];
    if (!participant) return Response.json({ error: 'Participante não encontrado neste evento.' }, { status: 404 });

    // Autorização: dono do registro, admin ou gestor do evento
    const isAdmin = user.role === 'admin';
    const callerPersonId = await resolveUserPersonId(base44, user);
    const ownsParticipant =
      (participant.email && user.email && participant.email.toLowerCase() === user.email.toLowerCase()) ||
      (participant.person_id && callerPersonId && participant.person_id === callerPersonId);
    if (!isAdmin && !ownsParticipant) {
      const { authorized } = await verifyEventMembership(base44, user, session.event_id, EVENT_MANAGER_ROLES);
      if (!authorized) {
        return Response.json({ error: 'Sem permissão para este participante.' }, { status: 403 });
      }
    }

    // Presença atual (re-check server-side sempre — previne duplicatas/cache stale)
    const attendances = await svc.entities.SessionAttendance.filter({
      session_id: sessionId,
      participant_id: participantId,
    });
    const present = attendances.find((a) => a.is_present !== false) || null;

    if (action === 'status') {
      return Response.json({ isPresent: !!present, attendance: present });
    }

    if (action === 'unregister') {
      if (present) {
        // Item 2 — flip CONDICIONAL (present→false): em corrida, só quem
        // executou a transição decrementa o gate de capacidade (sem dupla
        // contagem em unregister concorrente).
        const flip = await svc.entities.SessionAttendance.updateMany(
          { id: present.id, is_present: true },
          { $set: { is_present: false } }
        );
        if (flip && flip.updated && session.capacity && session.capacity > 0) {
          try {
            await svc.entities.Session.updateMany(
              { id: sessionId, presence_count: { $gt: 0 } },
              { $inc: { presence_count: -1 } }
            );
          } catch { /* gate é best-effort no unregister */ }
        }
      }
      return Response.json({ isPresent: false });
    }

    // register
    if (present) {
      return Response.json({ isPresent: true, attendance: present });
    }

    // ===== Item 2 (2026-10-09) — Gate atômico de capacidade =====
    // A vaga é CLAIMADA na Session (updateMany condicional {$lt: capacity} +
    // $inc) ANTES do create — em corrida, exatamente um vencedor por vaga
    // (anti-oversell). Sessões legadas recebem backfill lazy do contador.
    // null/0 = sem limite (ex: eventos online).
    let claimedSlot = false;
    if (session.capacity && session.capacity > 0) {
      const fresh = await ensurePresenceCount(svc, sessionId);
      const capacity = fresh?.capacity || 0;
      if (capacity > 0) {
        const claim = await svc.entities.Session.updateMany(
          { id: sessionId, presence_count: { $lt: capacity } },
          { $inc: { presence_count: 1 } }
        );
        if (!claim || !claim.updated) {
          return Response.json({ error: 'A sessão está lotada. Não é possível registrar presença.' }, { status: 409 });
        }
        claimedSlot = true;
      }
    }

    const now = new Date().toISOString();
    let attendance: any;
    try {
      attendance = await svc.entities.SessionAttendance.create({
        event_id: session.event_id,
        session_id: sessionId,
        participant_id: participantId,
        person_id: participant.person_id || callerPersonId || null,
        is_present: true,
        registered_at: now,
      });
    } catch (createErr: any) {
      // Compensação: create falhou → devolve a vaga claimada.
      if (claimedSlot) {
        try {
          await svc.entities.Session.updateMany(
            { id: sessionId, presence_count: { $gt: 0 } },
            { $inc: { presence_count: -1 } }
          );
        } catch { /* best-effort */ }
      }
      throw createErr;
    }

    // Dedup pós-create (concorrência): sobrevivente determinístico entre as
    // presenças do par (sessão, participante); o perdedor é removido e a vaga
    // claimada devolvida — retorno idempotente com o registro sobrevivente.
    const mine = await svc.entities.SessionAttendance.filter({
      session_id: sessionId,
      participant_id: participantId,
    });
    const presentDocs = (mine || []).filter((a: any) => a.is_present !== false);
    if (presentDocs.length > 1) {
      const sorted = [...presentDocs].sort(deterministicCompare);
      const extras = sorted.slice(1);
      const iAmExtra = extras.some((e: any) => e.id === attendance.id);
      for (const e of extras) {
        try { await svc.entities.SessionAttendance.delete(e.id); } catch { /* idempotente */ }
      }
      if (iAmExtra) {
        if (claimedSlot) {
          try {
            await svc.entities.Session.updateMany(
              { id: sessionId, presence_count: { $gt: 0 } },
              { $inc: { presence_count: -1 } }
            );
          } catch { /* best-effort */ }
        }
        return Response.json({ isPresent: true, attendance: sorted[0] });
      }
    }

    // Lead de sessão (o palestrante vê quem assistiu) + contadores — best-effort
    if (session.speaker_name) {
      try {
        const lead = await svc.entities.Lead.create({
          event_id: session.event_id,
          participant_id: participantId,
          participant_name: participant.full_name || '',
          participant_email: participant.email || '',
          source: 'session',
          notes: `Presença na sessão: ${session.title || ''}`.slice(0, 500),
          created_day: now.slice(0, 10),
        });
        await incLeads(svc, session.event_id, '', lead?.created_date || now);
      } catch (e) { /* best-effort */ }
    }

    return Response.json({ isPresent: true, attendance });
  } catch (error) {
    console.error('manageSessionAttendance error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}