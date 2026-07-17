import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { action } = body;

    if (action === "send") {
      return await handleSendRequest(base44, body, user);
    } else if (action === "accept") {
      return await handleAcceptRequest(base44, body, user);
    }
    return Response.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});

async function handleSendRequest(base44, { eventId, requesterPersonId, requesterName, receiverPersonId, receiverName, requesterParticipantId }, user) {
  // Verify ownership: requesterPersonId must belong to calling user
  const userPersons = await base44.asServiceRole.entities.Person.filter({ contact_email: user.email });
  const userPersonId = userPersons[0]?.id;
  if (requesterPersonId !== userPersonId && user.role !== 'admin') {
    return Response.json({ ok: false, reason: 'unauthorized' }, { status: 403 });
  }
  const [aId, bId] = sortPersonIds(requesterPersonId, receiverPersonId);
  const safeReqName = sanitizeText(requesterName);
  const safeRcvName = sanitizeText(receiverName);

  // 1. Já conectados?
  const existingConn = await base44.asServiceRole.entities.Connection.filter({
    event_id: eventId, person_a_id: aId, person_b_id: bId, is_deleted: false,
  });
  if (existingConn?.length > 0) return Response.json({ ok: false, reason: "already_connected" });

  // 2. Pedido pendente em qualquer direção?
  const reqsForward = await base44.asServiceRole.entities.ConnectionRequest.filter({
    event_id: eventId, requester_person_id: requesterPersonId, receiver_person_id: receiverPersonId, is_deleted: false,
  });
  const reqsReverse = await base44.asServiceRole.entities.ConnectionRequest.filter({
    event_id: eventId, requester_person_id: receiverPersonId, receiver_person_id: requesterPersonId, is_deleted: false,
  });
  const allReqs = [...(reqsForward || []), ...(reqsReverse || [])];
  const pending = allReqs.find((r) => r.status === "pending");

  if (pending) {
    if (pending.requester_person_id === receiverPersonId) {
      // Auto-aceitar
      await acceptConnectionInternal(base44, {
        request: pending,
        eventId,
        accepterPersonId: requesterPersonId,
        accepterName: safeReqName,
        accepterParticipantId: requesterParticipantId,
      });
      return Response.json({ ok: true, reason: "auto_accepted" });
    }
    return Response.json({ ok: false, reason: "already_pending" });
  }

  // 3. Criar pedido
  await base44.asServiceRole.entities.ConnectionRequest.create({
    event_id: eventId,
    requester_person_id: requesterPersonId,
    requester_name: safeReqName,
    receiver_person_id: receiverPersonId,
    receiver_name: safeRcvName,
    status: "pending",
  });

  return Response.json({ ok: true, reason: "request_sent" });
}

async function handleAcceptRequest(base44, { requestId, eventId, accepterPersonId, accepterName, accepterParticipantId }, user) {
  // Verify ownership: accepterPersonId must belong to calling user
  const userPersons = await base44.asServiceRole.entities.Person.filter({ contact_email: user.email });
  const userPersonId = userPersons[0]?.id;
  if (accepterPersonId !== userPersonId && user.role !== 'admin') {
    return Response.json({ ok: false, reason: 'unauthorized' }, { status: 403 });
  }
  const requests = await base44.asServiceRole.entities.ConnectionRequest.filter({ id: requestId, is_deleted: false });
  if (!requests?.length) return Response.json({ ok: false, reason: "not_found" });
  const request = requests[0];

  if (request.status === "accepted") return Response.json({ ok: true, reason: "already_accepted" });
  if (request.status === "refused") return Response.json({ ok: false, reason: "already_refused" });

  await acceptConnectionInternal(base44, {
    request,
    eventId,
    accepterPersonId,
    accepterName,
    accepterParticipantId,
  });

  return Response.json({ ok: true, reason: "accepted" });
}

async function acceptConnectionInternal(base44, { request, eventId, accepterPersonId, accepterName, accepterParticipantId }) {
  const safeReqName = sanitizeText(request.requester_name);
  const safeAccepterName = sanitizeText(accepterName);

  // Atualizar pedido
  await base44.asServiceRole.entities.ConnectionRequest.update(request.id, { status: "accepted" });

  // Criar conexão com proteção de race (check-then-create server-side)
  const [aId, bId] = sortPersonIds(request.requester_person_id, accepterPersonId);
  const existingConn = await base44.asServiceRole.entities.Connection.filter({
    event_id: eventId, person_a_id: aId, person_b_id: bId, is_deleted: false,
  });
  if (!existingConn?.length) {
    await base44.asServiceRole.entities.Connection.create({
      event_id: eventId,
      person_a_id: aId,
      person_b_id: bId,
      person_a_name: aId === request.requester_person_id ? safeReqName : safeAccepterName,
      person_b_name: bId === request.requester_person_id ? safeReqName : safeAccepterName,
    });
  }

  // Buscar participant ID do requester
  const requesterParts = await base44.asServiceRole.entities.Participant.filter({
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