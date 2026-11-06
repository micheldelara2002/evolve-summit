// 2026-11-06 — IDENTIDADE PARA ESCRITA DO PRÓPRIO AUTOR.
//
// Registro criado em nome do usuário autenticado (submissão CFP, case de
// premiação) precisa de uma Person ÚNICA. Ambiguidade nunca é resolvida
// "pegando a primeira": o pedido é negado com motivo claro.
//
// Import (de um entry.ts):
//   import { ensureSelfPerson } from "../../shared/selfPerson.ts";

import { resolveIdentity, normalizeEmail } from "./identity.ts";
import { incPersons } from "./businessMetrics.ts";

export type SelfPersonOk = {
  ok: true;
  personId: string;
  personName: string;
  email: string;
  identity: any;
};

export type SelfPersonDenied = { ok: false; status: number; error: string };

/**
 * Garante Person + vínculo `User.person_id` para o usuário autenticado.
 * Nunca aceita person_id vindo do cliente.
 */
export async function ensureSelfPerson(
  base44: any,
  user: any,
): Promise<SelfPersonOk | SelfPersonDenied> {
  const identity = await resolveIdentity(base44, user);
  if (identity.ambiguous) {
    return {
      ok: false,
      status: 409,
      error:
        "Há mais de um cadastro de pessoa com o seu e-mail. A organização precisa consolidar seu cadastro antes de continuar.",
    };
  }

  const svc = base44.asServiceRole;
  const email = normalizeEmail(user?.email);
  let personId = identity.selfPersonId;
  let personName = user?.full_name || user?.email || "";

  if (personId) {
    const [own] = await svc.entities.Person.filter({ id: personId });
    if (own?.full_name) personName = own.full_name;
    return { ok: true, personId, personName, email, identity };
  }

  const created = await svc.entities.Person.create({
    full_name: personName,
    contact_email: email,
    is_active: true,
    created_day: new Date().toISOString().slice(0, 10),
  });
  if (!created?.id) {
    return { ok: false, status: 500, error: "Não foi possível criar seu cadastro de pessoa." };
  }

  await base44.auth.updateMe({ person_id: created.id });
  try {
    await incPersons(svc, created.created_date);
  } catch {
    /* contador é best-effort; reconcile corrige drift */
  }

  return { ok: true, personId: created.id, personName, email, identity };
}