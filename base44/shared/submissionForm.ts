// 2026-11-06 — VALIDAÇÃO DE CONTEÚDO SUBMETIDO (CFP e premiação).
//
// O autor só grava CONTEÚDO (título, resumo, tipo, respostas dos campos
// personalizados). Status, autoria e vínculos são decididos no servidor.
// A validação do navegador é conveniência; esta é a fronteira real.

export const SESSION_TYPES = [
  "aula",
  "debate",
  "demonstracao",
  "keynote",
  "mesa_redonda",
  "palestra",
  "painel",
  "simulacao",
  "workshop",
];

export const CONTENT_LIMITS = {
  titleMax: 200,
  summaryMax: 5000,
  answerMax: 3000,
};

export function parseFormConfig(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function optionsOf(field: any): string[] {
  if (Array.isArray(field?.options)) return field.options.map((o: any) => String(o));
  if (typeof field?.options === "string" && field.options.trim()) {
    return field.options.split(",").map((o: string) => o.trim()).filter(Boolean);
  }
  return [];
}

export type ContentResult =
  | { ok: true; title: string; summary: string; type: string | null }
  | { ok: false; error: string };

/**
 * Valida e normaliza o conteúdo fixo. `requireType` é usado só pelo CFP
 * (proposta de sessão); o case de premiação não tem tipo.
 */
export function validateContent(input: any, { requireType = false } = {}): ContentResult {
  const title = String(input?.title ?? "").trim();
  if (title.length < 3) return { ok: false, error: "Informe um título com pelo menos 3 caracteres." };
  if (title.length > CONTENT_LIMITS.titleMax) {
    return { ok: false, error: `O título pode ter no máximo ${CONTENT_LIMITS.titleMax} caracteres.` };
  }

  const summary = String(input?.summary ?? "").trim();
  if (!summary) return { ok: false, error: "Informe um resumo." };
  if (summary.length > CONTENT_LIMITS.summaryMax) {
    return { ok: false, error: `O resumo pode ter no máximo ${CONTENT_LIMITS.summaryMax} caracteres.` };
  }

  let type: string | null = null;
  const rawType = input?.type ?? input?.proposed_type;
  if (requireType) {
    type = String(rawType || "palestra");
    if (!SESSION_TYPES.includes(type)) return { ok: false, error: "Tipo de sessão inválido." };
  }

  return { ok: true, title, summary, type };
}

export type AnswersResult =
  | { ok: true; answers: Record<string, any> }
  | { ok: false; error: string };

/**
 * Valida as respostas contra o `form_config` ATUAL da chamada/premiação:
 * obrigatoriedade, opções válidas, tamanho máximo. Chaves fora do formulário
 * são descartadas (o autor não inventa campos).
 */
export function validateAnswers(formConfig: any, answers: any): AnswersResult {
  const fields = parseFormConfig(formConfig);
  const input = answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {};
  const clean: Record<string, any> = {};

  for (const field of fields) {
    const label = String(field?.label ?? "").trim();
    if (!label) continue;

    if (field?.type === "boolean") {
      const value = input[label];
      clean[label] = value === true || value === "true";
      continue;
    }

    const raw = input[label];
    const value = raw === undefined || raw === null ? "" : String(raw).trim().slice(0, CONTENT_LIMITS.answerMax);

    if (field?.required && !value) {
      return { ok: false, error: `Responda o campo obrigatório: ${label}` };
    }

    if (field?.type === "select" && value) {
      const options = optionsOf(field);
      if (options.length > 0 && !options.includes(value)) {
        return { ok: false, error: `Valor inválido para o campo: ${label}` };
      }
    }

    if (value) clean[label] = value;
  }

  return { ok: true, answers: clean };
}