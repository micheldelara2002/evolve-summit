// Realtime publish helpers for Session Polls — Lote Realtime Seguro e Escalável.
//
// Mecanismo: entidade PollEvent + RLS (data.recipient_emails contains {{user.email}}).
// O backend (service role) escreve registros PollEvent; o WebSocket entrega cada
// registro apenas aos usuários cujo email está em recipient_emails (autorização
// server-side via RLS, NÃO client-side). O frontend NÃO acessa SessionPollAnswer.
//
// Eventos:
//   poll_live / poll_closed → broadcast aos participantes ativos do evento (+ speaker).
//     1-N registros (chunked CHUNK_SIZE emails/registro) — não O(N) registros por user.
//   poll_results → upsert, SOMENTE speaker, com payload agregado (counts/totalResponses).
//
// Concorrência: contadores atômicos (voter_count em SessionPoll, vote_count em
// SessionPollOption) via $inc. SessionPollAnswer continua a source of truth (append-only).
// Legacy polls (contadores null) são backfilled uma vez (ensurePollCounters).
//
// Publicação ocorre APÓS o commit da resposta/estado. Falha de publish NÃO faz rollback
// (spec §7) — loga e segue; o client se recupera via fallback polling.
//
// Import (from a function entry.ts):
//   import { ensurePollCounters, publishPollResults, publishPollBroadcast, clearPollEvents } from "../../shared/pollRealtime.ts";

const CHUNK_SIZE = 500;

/** Resolve os emails dos participantes ativos de um evento (audiência do broadcast). */
export async function getEventParticipantEmails(svc: any, eventId: string): Promise<string[]> {
  const parts = await svc.entities.Participant.filter({
    event_id: eventId,
    is_deleted: false,
    registration_status: { $ne: 'cancelled' },
  });
  const emails = (parts || []).map((p: any) => p.email).filter((e: any) => !!e);
  return [...new Set(emails)];
}

/** Resolve o email do palestrante dono da session (via Session.speaker_id → Participant.email). */
export async function getSpeakerEmail(svc: any, session: any): Promise<string | null> {
  if (!session?.speaker_id) return null;
  try {
    const sp = await svc.entities.Participant.filter({ id: session.speaker_id, is_deleted: false });
    return sp?.[0]?.email || null;
  } catch {
    return null;
  }
}

/**
 * Garante que os contadores de uma poll existam. Legacy polls (voter_count null,
 * criadas antes deste lote) são backfilled UMA vez a partir das respostas existentes.
 * @returns { poll, options, backfilled } — backfilled=true indica que o contador já
 *   reflete o total atual (incluindo a resposta recém-criada, se chamada após o create);
 *   nesse caso o caller NÃO deve $inc novamente.
 */
export async function ensurePollCounters(svc: any, pollId: string): Promise<{ poll: any; options: any[]; backfilled: boolean }> {
  const polls = await svc.entities.SessionPoll.filter({ id: pollId, is_deleted: false });
  const poll = polls?.[0];
  const options = await svc.entities.SessionPollOption.filter({ poll_id: pollId, is_deleted: false });
  if (!poll) return { poll: null, options: [], backfilled: false };

  if (poll.voter_count == null) {
    // Backfill legado: calcula a partir de TODAS as respostas (inclui a recém-criada).
    const answers = await svc.entities.SessionPollAnswer.filter({ poll_id: pollId, is_deleted: false });
    const optCounts: Record<string, number> = {};
    for (const a of answers) {
      let ids: string[] = [];
      try { ids = JSON.parse(a.selected_option_ids || '[]'); } catch { ids = []; }
      for (const id of ids) optCounts[id] = (optCounts[id] || 0) + 1;
    }
    try {
      await svc.entities.SessionPoll.update(pollId, { voter_count: answers.length });
      poll.voter_count = answers.length;
      for (const o of options) {
        if (o.vote_count == null) {
          await svc.entities.SessionPollOption.update(o.id, { vote_count: optCounts[o.id] || 0 });
          o.vote_count = optCounts[o.id] || 0;
        }
      }
    } catch (e: any) {
      // Backfill best-effort; o refetch via getSessionPolls (source of truth = answers) corrige.
    }
    return { poll, options, backfilled: true };
  }
  return { poll, options, backfilled: false };
}

/** Constrói o payload agregado de resultados a partir dos contadores. */
export function buildResultsPayload(poll: any, options: any[]) {
  const counts: Record<string, number> = {};
  for (const o of options) counts[o.id] = o.vote_count || 0;
  const totalVotes = options.reduce((s: number, o: any) => s + (o.vote_count || 0), 0);
  return {
    totalResponses: poll.voter_count || 0,
    totalVotes,
    counts,
  };
}

/**
 * Publica (upsert) um evento poll_results ao palestrante com o agregado.
 * 1 registro por poll (update se existir, senão create). O(1) por voto.
 */
export async function publishPollResults(svc: any, poll: any, session: any, options: any[]): Promise<void> {
  const speakerEmail = await getSpeakerEmail(svc, session);
  if (!speakerEmail) return;
  const payload = JSON.stringify(buildResultsPayload(poll, options));
  try {
    const existing = await svc.entities.PollEvent.filter({ poll_id: poll.id, type: 'poll_results', is_deleted: false });
    if (existing && existing.length > 0) {
      await svc.entities.PollEvent.update(existing[0].id, { payload, recipient_emails: [speakerEmail] });
    } else {
      await svc.entities.PollEvent.create({
        recipient_emails: [speakerEmail],
        poll_id: poll.id,
        session_id: poll.session_id,
        event_id: poll.event_id,
        type: 'poll_results',
        payload,
      });
    }
  } catch (e: any) {
    // Falha de publish não compromete a resposta (source of truth = database).
    console.error('[pollRealtime] publishPollResults failed:', e?.message || e);
  }
}

/**
 * Publica um evento broadcast (poll_live | poll_closed) aos participantes ativos do
 * evento + speaker. Limpa eventos antigos do poll (bounds storage). Chunked para
 * manter registros leves (campo recipient_emails ≤ CHUNK_SIZE emails).
 */
export async function publishPollBroadcast(
  svc: any,
  poll: any,
  session: any,
  type: 'poll_live' | 'poll_closed',
  extraPayload: Record<string, any> = {},
): Promise<void> {
  try {
    // Limpa eventos antigos deste poll (todos os tipos) — bound de volume.
    await svc.entities.PollEvent.deleteMany({ poll_id: poll.id });
  } catch (e: any) {
    console.error('[pollRealtime] clearPollEvents (pre-broadcast) failed:', e?.message || e);
  }
  const audience = await getEventParticipantEmails(svc, poll.event_id);
  const speakerEmail = await getSpeakerEmail(svc, session);
  if (speakerEmail && !audience.includes(speakerEmail)) audience.push(speakerEmail);
  if (!audience.length) return;
  const payload = JSON.stringify(extraPayload);
  try {
    for (let i = 0; i < audience.length; i += CHUNK_SIZE) {
      const chunk = audience.slice(i, i + CHUNK_SIZE);
      await svc.entities.PollEvent.create({
        recipient_emails: chunk,
        poll_id: poll.id,
        session_id: poll.session_id,
        event_id: poll.event_id,
        type,
        payload,
      });
    }
  } catch (e: any) {
    console.error('[pollRealtime] publishPollBroadcast failed:', e?.message || e);
  }
}

/** Limpa todos os eventos realtime de um poll (na exclusão do poll). */
export async function clearPollEvents(svc: any, pollId: string): Promise<void> {
  try {
    await svc.entities.PollEvent.deleteMany({ poll_id: pollId });
  } catch (e: any) {
    console.error('[pollRealtime] clearPollEvents failed:', e?.message || e);
  }
}