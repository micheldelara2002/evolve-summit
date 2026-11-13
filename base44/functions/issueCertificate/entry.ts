import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { deterministicCompare } from "../../shared/deterministicSurvivor.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";
import { buildAuditKey } from "../../shared/auditTrail.ts";
import { auditCertificateIssuance } from "../../shared/certificateAudit.ts";

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { action, eventId, participantId, tipo, template, customTemplateId, sessionId } = await req.json();

    // list: certificados emitidos do evento — admin OU gerente/equipe.
    // (Certificate tem RLS admin-only; a listagem passa por aqui.)
    if (action === 'list') {
      if (!eventId) return Response.json({ error: 'eventId obrigatório.' }, { status: 400 });
      const listAuth = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
      if (!listAuth.authorized) return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      const certificates = await base44.asServiceRole.entities.Certificate.filter(
        { event_id: eventId, is_deleted: false },
        '-created_date',
        1000
      );
      return Response.json({ certificates });
    }

    if (!eventId || !participantId || !tipo) {
      return Response.json({ error: 'Parâmetros obrigatórios ausentes.' }, { status: 400 });
    }

    // P0.2: Event-scoped authorization — admin or event manager/team
    const certAuth = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
    if (!certAuth.authorized) {
      return Response.json({ error: 'Sem permissão para emitir certificados neste evento.' }, { status: 403 });
    }

    // Fetch participant fresh from DB
    const participants = await base44.asServiceRole.entities.Participant.filter({
      id: participantId,
      event_id: eventId,
      is_deleted: false,
    });
    if (!participants.length) {
      return Response.json({ error: 'Participante não encontrado.' }, { status: 404 });
    }
    const participant = participants[0];

    // Idempotency: check if certificate already exists
    const existingFilter = {
      event_id: eventId,
      participant_id: participantId,
      tipo,
      is_deleted: false,
    };
    if (tipo === 'palestra' && sessionId) {
      existingFilter.session_id = sessionId;
    }
    const existing = await base44.asServiceRole.entities.Certificate.filter(existingFilter);
    if (existing && existing.length > 0) {
      // F3-11 (2026-11-12) — RECUPERAÇÃO DA TRILHA NA REEMISSÃO.
      // Antes: retorno imediato de `alreadyExisted`, sem tocar na auditoria. Um
      // certificado cuja emissão falhou na trilha principal E na pendência
      // ficava permanentemente sem trilha — e a reemissão nunca a recuperava.
      // Agora a mesma chave determinística é reaplicada: trilha existente é
      // apenas confirmada (sem novo registro); ausente é gravada agora; se
      // principal e pendência falharem, a resposta é explícita (503).
      const found = existing[0];
      try {
        const outcome = await auditCertificateIssuance(
          base44.asServiceRole,
          buildCertificateAuditEntry({ certificate: found, eventId, participantId, tipo, sessionId, user }),
        );
        return Response.json({
          certificate: found,
          alreadyExisted: true,
          audit_state: outcome.state,
          audit_recovered: outcome.state === 'recorded' && !outcome.already_recorded,
        });
      } catch (err: any) {
        console.error('[issueCertificate] reemissão: auditoria indisponível:', err?.message || err);
        return Response.json({
          error: 'Certificado já existe, mas a trilha de auditoria não pôde ser registrada. Repita a emissão para concluir a auditoria.',
          certificate: found,
          alreadyExisted: true,
          audit_state: 'unavailable',
        }, { status: 503 });
      }
    }

    // Consistency check: palestra certificate requires session speaker match
    if (tipo === 'palestra' && sessionId) {
      const sessions = await base44.asServiceRole.entities.Session.filter({
        id: sessionId,
        event_id: eventId,
        is_deleted: false,
      });
      const session = sessions[0];
      if (!session) {
        return Response.json({ error: 'Sessão não encontrada.' }, { status: 404 });
      }
      if (session.speaker_id !== participantId) {
        return Response.json({ error: 'Este palestrante não está vinculado a esta sessão.' }, { status: 400 });
      }
    }

    // Generate unique hash with server-side collision check (up to 5 attempts)
    // P3 — colisão após 5 tentativas é erro explícito (antes: usava o último
    // hash SEM checar, podendo gravar código duplicado).
    let finalHash = generateSecureHash();
    let hashOk = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const collision = await base44.asServiceRole.entities.Certificate.filter({
        hash_code: finalHash,
        is_deleted: false,
      });
      if (!collision || collision.length === 0) { hashOk = true; break; }
      finalHash = generateSecureHash();
    }
    if (!hashOk) {
      return Response.json({ error: 'Colisão de código de validação — tente novamente.' }, { status: 500 });
    }

    const certificate = await base44.asServiceRole.entities.Certificate.create({
      event_id: eventId,
      person_id: participant.person_id || '',
      participant_id: participantId,
      session_id: tipo === 'palestra' ? (sessionId || undefined) : undefined,
      tipo,
      template: customTemplateId ? 'classico' : (template || 'classico'),
      custom_template_id: customTemplateId || undefined,
      hash_code: finalHash,
      issued_by_user_id: user.id,
      issued_by_name: user.full_name,
      email_sent: false,
    });

    // P1 — Dedup pós-create: duas emissões concorrentes podem passar ambas na
    // checagem acima. Re-query determinística (created_date + id) mantém um
    // sobrevivente e cancela as duplicatas — exatamente um certificado por
    // participante/tipo/sessão.
    let finalCertificate = certificate;
    let deduplicated = 0;
    const allCertificates = await base44.asServiceRole.entities.Certificate.filter(existingFilter);
    if (allCertificates.length > 1) {
      allCertificates.sort(deterministicCompare);
      const survivor = allCertificates[0];
      const duplicateIds = allCertificates.slice(1).map((c: any) => c.id);
      try {
        await base44.asServiceRole.entities.Certificate.bulkUpdate(
          duplicateIds.map((id: string) => ({ id, is_deleted: true }))
        );
        finalCertificate = survivor;
        deduplicated = duplicateIds.length;
      } catch (err: any) {
        console.error('[issueCertificate] dedup falhou:', err?.message || err);
      }
    }

    // F3-09 (2026-11-12) — TRILHA da emissão: emitir certificado era a única
    // operação crítica do evento sem registro de auditoria. Chave determinística
    // (certificado_emitido|<id>) ⇒ reexecução não duplica. Falha de trilha NÃO
    // silencia: o certificado já existe, então o caso vai para trilha PENDENTE
    // (reconciliada por resolvePendingTrails) — nunca é descartado.
    const auditEntry = buildCertificateAuditEntry({
      certificate: finalCertificate,
      eventId,
      participantId,
      tipo,
      sessionId,
      user,
      deduplicated,
    });
    try {
      const auditOutcome = await auditCertificateIssuance(base44.asServiceRole, auditEntry);
      return Response.json({
        certificate: finalCertificate,
        alreadyExisted: false,
        audit_state: auditOutcome.state,
        ...(deduplicated ? { deduplicated } : {}),
      });
    } catch (err: any) {
      // F3-09 — trilha principal E pendência falharam: não existe evidência
      // persistida de auditoria. Falha EXPLÍCITA (503); o certificado já existe
      // e a próxima tentativa cai na deduplicação, que regrava a trilha com a
      // mesma chave (sem duplicar certificado nem registro).
      console.error('[issueCertificate] auditoria indisponível:', err?.message || err);
      return Response.json({
        error: 'Certificado emitido, mas a trilha de auditoria não pôde ser registrada. Repita a emissão para concluir a auditoria.',
        certificate: finalCertificate,
        audit_state: 'unavailable',
      }, { status: 503 });
    }
  } catch (error: any) {
    return Response.json({ error: error?.message || String(error) }, { status: 500 });
  }
}

// F3-11 — entrada de trilha ÚNICA para emissão e reemissão: a chave
// determinística depende só do certificado (`certificado_emitido|<id>`), então
// a reemissão confirma a trilha existente em vez de duplicá-la.
function buildCertificateAuditEntry({ certificate, eventId, participantId, tipo, sessionId, user, deduplicated = 0 }) {
  return {
    action: 'create',
    entity_type: 'Certificate',
    entity_id: certificate.id,
    user_id: user.id,
    user_name: user.full_name || user.email || '',
    event_id: eventId,
    audit_key: buildAuditKey('certificado_emitido', certificate.id),
    details: JSON.stringify({
      tipo,
      participant_id: participantId,
      session_id: sessionId || '',
      template: certificate.template || 'classico',
      deduplicated,
    }),
  };
}

function generateSecureHash() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return (hex.slice(0, 8) + '-' + hex.slice(8, 16)).toUpperCase();
}