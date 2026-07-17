import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function buildIdempotencyKey({ eventId, participantId, acao, refId, limiteTipo }) {
  switch (limiteTipo) {
    case "one_shot":
      return `${eventId}:${participantId}:${acao}`;
    case "por_sessao":
    case "por_estande":
      return `${eventId}:${participantId}:${acao}:${refId}`;
    case "por_par_usuarios":
      return `${eventId}:${participantId}:${acao}:${refId}`;
    default:
      return `${eventId}:${participantId}:${acao}:${refId}`;
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { eventId, participantId, personId, acao, refId = "" } = await req.json();
    if (!eventId || !participantId || !acao) {
      return Response.json({ error: 'Parâmetros obrigatórios ausentes.' }, { status: 400 });
    }

    // Verify participant ownership — prevents crediting points to arbitrary participants
    const targetParts = await base44.asServiceRole.entities.Participant.filter({ id: participantId, is_deleted: false });
    const targetPart = targetParts[0];
    if (!targetPart) return Response.json({ error: 'Participante não encontrado.' }, { status: 404 });
    const isOwner = targetPart.email === user.email;
    const isAdminUser = user.role === 'admin';
    if (!isOwner && !isAdminUser) {
      // Allow if calling user is also a participant in the same event (system-triggered actions like connection scoring)
      const callerParts = await base44.asServiceRole.entities.Participant.filter({
        event_id: targetPart.event_id, email: user.email, is_deleted: false,
      });
      if (callerParts.length === 0) {
        return Response.json({ error: 'Sem permissão para creditar pontos para este participante.' }, { status: 403 });
      }
    }

    // Resgate: cria PointTransaction com 0 pontos, sem creditar
    if (acao === "resgate_realizado") {
      const chave = `${eventId}:${participantId}:${acao}:${refId}`;
      const existing = await base44.asServiceRole.entities.PointTransaction.filter({ chave_idempotencia: chave });
      if (existing && existing.length > 0) {
        return Response.json({ credited: false, pontos: 0, reason: "limit_reached" });
      }
      await base44.asServiceRole.entities.PointTransaction.create({
        event_id: eventId,
        participant_id: participantId,
        person_id: personId || undefined,
        acao,
        pontos: 0,
        chave_idempotencia: chave,
        ref_id: refId || undefined,
        descricao: `resgate_realizado — ${refId || ""}`.trim(),
      });
      return Response.json({ credited: false, pontos: 0, reason: "resgate_no_points" });
    }

    // 1. Buscar regra ativa
    const rules = await base44.asServiceRole.entities.ScoringRule.filter({
      event_id: eventId, acao, ativo: true, is_deleted: false,
    });
    if (!rules || rules.length === 0) {
      return Response.json({ credited: false, pontos: 0, reason: "no_rule" });
    }
    const rule = rules[0];

    // 2. Montar chave de idempotência
    const chave = buildIdempotencyKey({ eventId, participantId, acao, refId, limiteTipo: rule.limite_tipo });

    // 3. Verificar duplicata (fresh, server-side — race window minimizada)
    const existing = await base44.asServiceRole.entities.PointTransaction.filter({ chave_idempotencia: chave });
    if (existing && existing.length >= (rule.limite_valor || 1)) {
      return Response.json({ credited: false, pontos: 0, reason: "limit_reached" });
    }

    // 4. Registrar transação
    await base44.asServiceRole.entities.PointTransaction.create({
      event_id: eventId,
      participant_id: participantId,
      person_id: personId || undefined,
      acao,
      scoring_rule_id: rule.id,
      pontos: rule.pontos,
      chave_idempotencia: chave,
      ref_id: refId || undefined,
      descricao: `${acao} — ${refId || ""}`.trim(),
    });

    // 5. ATOMIC increment — elimina race condition de read-modify-write
    await base44.asServiceRole.entities.Participant.updateMany(
      { id: participantId },
      { $inc: { points_total: rule.pontos } }
    );

    return Response.json({ credited: true, pontos: rule.pontos });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});