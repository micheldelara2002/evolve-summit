// Fase 3 (Etapa 3.5) — marcadores e construtores de ANONIMIZAÇÃO usados pela
// exclusão de conta (deleteMyAccount). Fonte única: antes os marcadores viviam
// soltos dentro da função e cada novo campo anonimizado repetia a string.
//
// Regra: o marcador NUNCA deriva do valor original. Não é e-mail válido e não é
// documento utilizável, então não permite reidentificação nem nova utilização.
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