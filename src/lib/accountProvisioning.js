import { base44 } from "@/api/base44Client";

/**
 * Cadastro atômico (2026-11-04) — User e Person nascem juntos.
 *
 * Provisiona (ou reaproveita) a Person única da conta e confirma o vínculo
 * User.person_id no servidor. Só devolve `ok` quando o vínculo está gravado —
 * ou seja, quando o cadastro está de fato concluído. Qualquer falha mantém o
 * acesso bloqueado e devolve uma mensagem neutra para a pessoa.
 */
const NEUTRAL_MESSAGE = "Seu cadastro não foi concluído. Tente novamente.";

export async function provisionMyPerson() {
  try {
    const response = await base44.functions.invoke("getOrCreatePerson", {});
    const data = response?.data || {};
    if (data?.person_id) return { ok: true, personId: data.person_id };
    return { ok: false, message: data?.error || NEUTRAL_MESSAGE };
  } catch (error) {
    const data = error?.response?.data || {};
    return { ok: false, message: data?.error || NEUTRAL_MESSAGE };
  }
}