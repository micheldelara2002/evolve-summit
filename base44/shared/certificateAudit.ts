// F3-09 (rodada de correção 2026-11-12) — TRILHA da emissão de certificado com
// estado RASTREÁVEL até o fim.
//
// CONTEXTO: a emissão já gravava trilha obrigatória (`writeMandatoryAudit`) e,
// em falha, registrava uma pendência (`recordPendingTrail`). Faltava o que
// acontece quando as DUAS falham: o certificado ficava emitido e o erro ia só
// para o `console.error` — mensagem em log não é trilha persistida.
//
// CONTRATO desta função (usada por `issueCertificate`):
//   • trilha principal gravada  → { state: 'recorded', audit_id }
//   • principal falhou, pendência GRAVADA E RELIDA com sucesso
//                               → { state: 'pending', pending_id }
//   • principal e pendência falharam
//                               → AuditUnavailableError (o chamador devolve
//                                 falha explícita; nada é declarado auditado)
//
// Recuperação do caso sem pendência persistida: o certificado já existe, então
// uma nova tentativa de emissão cai no caminho de deduplicação e regrava a
// trilha com a MESMA chave determinística (`certificado_emitido|<id>`) — sem
// duplicar certificado nem registro. Quando a pendência existe, quem conclui é
// `resolvePendingTrails` (mesma chave, idempotente).
//
// Não há outbox nem fila distribuída: a pendência usa a própria entidade
// AuditLog (status 'pending'), que já era o mecanismo do projeto.
import { writeMandatoryAudit, recordPendingTrailVerified, AuditUnavailableError } from './auditTrail.ts';

export type CertificateAuditOutcome = {
  state: 'recorded' | 'pending';
  audit_id: string | null;
  pending_id: string | null;
};

export async function auditCertificateIssuance(
  svc: any,
  entry: Record<string, any>,
): Promise<CertificateAuditOutcome> {
  try {
    const written = await writeMandatoryAudit(svc, entry);
    return { state: 'recorded', audit_id: written.id, pending_id: null };
  } catch (err: any) {
    const failure = err?.message || String(err);
    const pending = await recordPendingTrailVerified(svc, {
      ...entry,
      provider: 'base44',
      failure_reason: failure,
    });
    if (pending) {
      return { state: 'pending', audit_id: null, pending_id: pending.id };
    }
    // Sem trilha principal e sem pendência confirmada: não existe evidência
    // persistida. Falhar explicitamente é o único desfecho honesto.
    throw new AuditUnavailableError(
      `Trilha do certificado indisponível (principal e pendência falharam): ${failure}`,
    );
  }
}