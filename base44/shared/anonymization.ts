// Fase 3 (Etapa 3.5) — marcadores e construtores de ANONIMIZAÇÃO usados pela
// exclusão de conta (deleteMyAccount). Fonte única: antes os marcadores viviam
// soltos dentro da função e cada novo campo anonimizado repetia a string.
//
// Regra: o marcador NUNCA deriva do valor original. Não é e-mail válido e não é
// documento utilizável, então não permite reidentificação nem nova utilização.
import { scanBatches } from './completeScan.ts';

export const DELETED_NAME = "Usuário Excluído";
export const DELETED_EMAIL_MARKER = "conta_excluida";
export const DELETED_DOCUMENT = "DOCUMENTO_EXCLUIDO";

// Autoria de proposta (CFP) e de case (premiação): o snapshot guarda nome e
// e-mail do autor — PII que sobrevivia à exclusão de conta (F3-07).
export function submissionAuthorAnon(id: string) {
  return { id, submitter_name: DELETED_NAME, submitter_email: DELETED_EMAIL_MARKER };
}

// Vaga de emprego publicada pela pessoa: nome e e-mail de contato no anúncio.
export function jobPostingAuthorAnon(id: string) {
  return { id, poster_name: DELETED_NAME, contact_email: DELETED_EMAIL_MARKER };
}

// ===========================================================================
// F3-07 (rodada de correção 2026-11-12) — passo de anonimização de AUTORIA
// extraído de deleteMyAccount para ser TESTÁVEL no nível de integração.
//
// Antes vivia inline na função (inacessível a teste). A lógica é idêntica:
// varre cada entidade por `person_id` E pelas variantes do e-mail, remove
// duplicatas encontradas por consultas diferentes (Set por id), aplica o
// marcador em LOTES e é idempotente — reexecutar reescreve o mesmo marcador.
//
// dryRun: executa todas as leituras e conta, sem NENHUMA escrita.
// Falha de um lote: propaga (a função devolve 500) e a reexecução retoma —
// quem já recebeu o marcador é reescrito com o mesmo valor (no-op lógico).
// ===========================================================================
export type AuthoredContentCounts = {
  submissions: number;
  awardSubmissions: number;
  jobPostings: number;
};

export async function anonymizeAuthoredContent(
  svc: any,
  opts: {
    personIds?: string[];
    emailVariants?: string[];
    dryRun?: boolean;
    pageSize?: number;
  } = {},
): Promise<AuthoredContentCounts> {
  const personIds = Array.isArray(opts.personIds) ? opts.personIds.filter(Boolean) : [];
  const emailVariants = Array.isArray(opts.emailVariants) ? opts.emailVariants.filter(Boolean) : [];
  const dryRun = !!opts.dryRun;
  const pageSize = Number(opts.pageSize) || 500;

  const counts: AuthoredContentCounts = { submissions: 0, awardSubmissions: 0, jobPostings: 0 };

  const applyQueries = async (
    entity: any,
    builder: (id: string) => any,
    queries: any[],
    key: keyof AuthoredContentCounts,
  ) => {
    if (queries.length === 0 || !entity?.filter) return;
    const seen = new Set<string>();
    for (const query of queries) {
      for await (const batch of scanBatches(entity, query, { pageSize })) {
        const updates: any[] = [];
        for (const row of batch) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          updates.push(builder(row.id));
          counts[key]++;
        }
        if (!dryRun && updates.length > 0) await entity.bulkUpdate(updates);
      }
    }
  };

  const byPerson = personIds.length > 0 ? [{ person_id: { $in: personIds } }] : [];
  const bySubmitter = emailVariants.length > 0 ? [{ submitter_email: { $in: emailVariants } }] : [];
  const byContact = emailVariants.length > 0 ? [{ contact_email: { $in: emailVariants } }] : [];

  await applyQueries(svc.entities.Submission, submissionAuthorAnon, [...byPerson, ...bySubmitter], 'submissions');
  await applyQueries(svc.entities.AwardSubmission, submissionAuthorAnon, [...byPerson, ...bySubmitter], 'awardSubmissions');
  await applyQueries(svc.entities.JobPosting, jobPostingAuthorAnon, [...byPerson, ...byContact], 'jobPostings');

  return counts;
}