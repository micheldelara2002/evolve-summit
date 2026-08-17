import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";

function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim();
}

function sortPersonIds(a, b) {
  return a < b ? [a, b] : [b, a];
}

// P1 — Active participant in event: not soft-deleted, not cancelled.
// Used to validate that both ends of a connection are eligible participants
// in the SAME event, queried server-side (never trusting client eventId alone).
async function getActiveParticipant(svc, eventId, personId) {
  if (!eventId || !personId) return null;
  const parts = await svc.entities.Participant.filter({
    event_id: eventId, person_id: personId, is_deleted: false,
  });
  return parts.find((p) => p.registration_status !== "cancelled") || null;
}

// P1 — Person ids belonging to the authenticated user (resolved by contact_email).
async function getUserPersonIds(svc, user) {
  const persons = await svc.entities.Person.filter({ contact_email: user.email });
  return persons.map((p) => p.id);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json();
    const { action } = body;

    if (action === "send") {
      return await handleSendRequest(base44, body, user);
    } else if (action === "accept") {
      return await handleAcceptRequest(base44, body, user);
    } else if (action === "refuse") {
      return await handleRefuseRequest(base44, body, user);
    } else if (action === "cancel") {
      return await handleCancelRequest(base44, body, user);
    }
    return Response.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});

async function handleSendRequest(base44, { eventId, requesterPersonId, requesterName, receiverPersonId, receiverName }, user) {
  const svc = base44.asServiceRole;

  // P1 — required params + self-connection guard
  if (!eventId || !requesterPersonId || !receiverPersonId) {
    return Response.json({ ok: false, reason: "missing_params" }, { status: 400 });
  }
  if (requesterPersonId === receiverPersonId) {
    return Response.json({ ok: false, reason: "self_connection_not_allowed" }, { status: 400 });
  }

  // P1 — ownership: requesterPersonId must belong to the calling user
  const userPersonIds = await getUserPersonIds(svc, user);
  if (!userPersonIds.includes(requesterPersonId) && user.role !== 'admin') {
    return Response.json({ ok: false, reason: 'unauthorized' }, { status: 403 });
  }

  // P1 — both ends must have an active (non-deleted, non-cancelled) Participant in eventId.
  // Queried server-side — client eventId is not accepted as proof of participation.
  const requesterPart = await getActiveParticipant(svc, eventId, requesterPersonId);
  if (!requesterPart) {
    return Response.json({ ok: false, reason: "requester_not_active_in_event" }, { status: 403 });
  }
  const receiverPart = await getActiveParticipant(svc, eventId, receiverPersonId);
  if (!receiverPart) {
    return Response.json({ ok: false, reason: "receiver_not_active_in_event" }, { status: 403 });
  }

  const [aId, bId] = sortPersonIds(requesterPersonId, receiverPersonId);
  const safeReqName = sanitizeText(requesterName);
  const safeRcvName = sanitizeText(receiverName);

  // 1. Já conectados?
  const existingConn = await svc.entities.Connection.filter({
    event_id: eventId, person_a_id: aId, person_b_id: bId, is_deleted: false,
  });
  if (existingConn?.length > 0) return Response.json({ ok: false, reason: "already_connected" });

  // 2. Pedido pendente em qualquer direção?
  const reqsForward = await svc.entities.ConnectionRequest.filter({
    event_id: eventId, requester_person_id: requesterPersonId, receiver_person_id: receiverPersonId, is_deleted: false,
  });
  const reqsReverse = await svc.entities.ConnectionRequest.filter({
    event_id: eventId, requester_person_id: receiverPersonId, receiver_person_id: requesterPersonId, is_deleted: false,
  });
  const allReqs = [...(reqsForward || []), ...(reqsReverse || [])];
  const pending = allReqs.find((r) => r.status === "pending");

  if (pending) {
    if (pending.requester_person_id === receiverPersonId) {
      // Auto-aceitar — o accepter é o requester corrente; participant id resolvido do DB.
      await acceptConnectionInternal(base44, {
        request: pending,
        eventId,
        accepterPersonId: requesterPersonId,
        accepterName: safeReqName,
        accepterParticipantId: requesterPart.id,
      });
      return Response.json({ ok: true, reason: "auto_accepted" });
    }
    return Response.json({ ok: false, reason: "already_pending" });
  }

  // 3. Criar pedido
  await svc.entities.ConnectionRequest.create({
    event_id: eventId,
    requester_person_id: requesterPersonId,
    requester_name: safeReqName,
    receiver_person_id: receiverPersonId,
    receiver_name: safeRcvName,
    status: "pending",
  });

  return Response.json({ ok: true, reason: "request_sent" });
}

async function handleAcceptRequest(base44, { requestId, accepterPersonId, accepterName }, user) {
  const svc = base44.asServiceRole;

  // P1 — required params + ownership: accepterPersonId must belong to the calling user
  if (!requestId || !accepterPersonId) {
    return Response.json({ ok: false, reason: "missing_params" }, { status: 400 });
  }
  const userPersonIds = await getUserPersonIds(svc, user);
  if (!userPersonIds.includes(accepterPersonId) && user.role !== 'admin') {
    return Response.json({ ok: false, reason: 'unauthorized' }, { status: 403 });
  }

  const requests = await svc.entities.ConnectionRequest.filter({ id: requestId, is_deleted: false });
  if (!requests?.length) return Response.json({ ok: false, reason: "not_found" });
  const request = requests[0];

  // P1 — event scope: request.event_id is the SOURCE OF TRUTH.
  // Client-supplied eventId is ignored — prevents cross-event scope manipulation.
  const effectiveEventId = request.event_id;

  if (request.status === "accepted") return Response.json({ ok: true, reason: "already_accepted" });
  if (request.status === "refused") return Response.json({ ok: false, reason: "already_refused" });
  if (request.status !== "pending") return Response.json({ ok: false, reason: "not_pending" });

  // P1 — accepter must be the intended receiver (prevents accepting requests destined to others)
  if (request.receiver_person_id !== accepterPersonId && user.role !== 'admin') {
    return Response.json({ ok: false, reason: 'not_intended_receiver' }, { status: 403 });
  }

  // P1 — both ends must be active participants in the request's event
  const requesterPart = await getActiveParticipant(svc, effectiveEventId, request.requester_person_id);
  const receiverPart = await getActiveParticipant(svc, effectiveEventId, request.receiver_person_id);
  if (!requesterPart || !receiverPart) {
    return Response.json({ ok: false, reason: "participant_not_active" }, { status: 403 });
  }

  // Use DB-resolved participant id for scoring (do not trust client-supplied id).
  const safeAccepterName = sanitizeText(accepterName);
  await acceptConnectionInternal(base44, {
    request,
    eventId: effectiveEventId,
    accepterPersonId: request.receiver_person_id,
    accepterName: safeAccepterName,
    accepterParticipantId: receiverPart.id,
  });

  return Response.json({ ok: true, reason: "accepted" });
}

async function handleRefuseRequest(base44, { requestId }, user) {
  // Verify ownership: only the receiver can refuse — server-side guard
  const svc = base44.asServiceRole;
  const userPersons = await svc.entities.Person.filter({ contact_email: user.email });
  const userPersonId = userPersons[0]?.id;

  const requests = await svc.entities.ConnectionRequest.filter({ id: requestId, is_deleted: false });
  if (!requests?.length) return Response.json({ ok: false, reason: "not_found" });
  const request = requests[0];

  if (request.receiver_person_id !== userPersonId && user.role !== 'admin') {
    return Response.json({ ok: false, reason: 'unauthorized' }, { status: 403 });
  }
  if (request.status !== "pending") {
    return Response.json({ ok: false, reason: "not_pending" });
  }
  await svc.entities.ConnectionRequest.update(requestId, { status: "refused" });
  return Response.json({ ok: true, reason: "refused" });
}

async function handleCancelRequest(base44, { requestId }, user) {
  // Verify ownership: only the requester can cancel — server-side guard
  const svc = base44.asServiceRole;
  const userPersons = await svc.entities.Person.filter({ contact_email: user.email });
  const userPersonId = userPersons[0]?.id;

  const requests = await svc.entities.ConnectionRequest.filter({ id: requestId, is_deleted: false });
  if (!requests?.length) return Response.json({ ok: false, reason: "not_found" });
  const request = requests[0];

  if (request.requester_person_id !== userPersonId && user.role !== 'admin') {
    return Response.json({ ok: false, reason: 'unauthorized' }, { status: 403 });
  }
  if (request.status !== "pending") {
    return Response.json({ ok: false, reason: "not_pending" });
  }
  await svc.entities.ConnectionRequest.update(requestId, { status: "canceled" });
  return Response.json({ ok: true, reason: "canceled" });
}

async function acceptConnectionInternal(base44, { request, eventId, accepterPersonId, accepterName, accepterParticipantId }) {
  const svc = base44.asServiceRole;
  const safeReqName = sanitizeText(request.requester_name);
  const safeAccepterName = sanitizeText(accepterName);

  // Atualizar pedido
  await svc.entities.ConnectionRequest.update(request.id, { status: "accepted" });

  // Criar conexão com proteção de race (check-then-create server-side)
  const [aId, bId] = sortPersonIds(request.requester_person_id, accepterPersonId);
  const existingConn = await svc.entities.Connection.filter({
    event_id: eventId, person_a_id: aId, person_b_id: bId, is_deleted: false,
  });
  if (!existingConn?.length) {
    await svc.entities.Connection.create({
      event_id: eventId,
      person_a_id: aId,
      person_b_id: bId,
      person_a_name: aId === request.requester_person_id ? safeReqName : safeAccepterName,
      person_b_name: bId === request.requester_person_id ? safeReqName : safeAccepterName,
    });

    // Post-create dedup: se dois accepts concorrentes criaram conexões duplicadas,
    // remove as extras mantendo apenas a primeira (mais antiga)
    const afterCreate = await svc.entities.Connection.filter({
      event_id: eventId, person_a_id: aId, person_b_id: bId, is_deleted: false,
    });
    if (afterCreate?.length > 1) {
      const sorted = [...afterCreate].sort((a, b) =>
        new Date(a.created_date) - new Date(b.created_date)
      );
      const duplicates = sorted.slice(1);
      await svc.entities.Connection.bulkUpdate(
        duplicates.map((c) => ({ id: c.id, is_deleted: true }))
      );
    }
  }

  // Buscar participant ID do requester
  const requesterParts = await svc.entities.Participant.filter({
    event_id: eventId, person_id: request.requester_person_id, is_deleted: false,
  });
  const requesterParticipantId = requesterParts?.[0]?.id;

  // Disparar pontuação para ambos — best-effort com retry (idempotente, seguro retentar)
  if (accepterParticipantId && requesterParticipantId) {
    const scoringCalls = [
      () => base44.functions.invoke('processScoringAction', {
        eventId, participantId: accepterParticipantId, acao: "conexao_aceita", refId: requesterParticipantId,
      }),
      () => base44.functions.invoke('processScoringAction', {
        eventId, participantId: requesterParticipantId, acao: "conexao_aceita", refId: accepterParticipantId,
      }),
    ];

    // Executa ambos em paralelo; falha de um não bloqueia o outro
    const results = await Promise.allSettled(scoringCalls.map((fn) => fn()));

    // Retry dos que falharam (idempotente — seguro retentar)
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        try {
          await scoringCalls[i]();
        } catch {
          // Scoring falhou após retry — conexão já foi aceita; idempotência permite recuperação posterior
        }
      }
    }
  }
}