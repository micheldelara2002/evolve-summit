import { base44 } from "@/api/base44Client";

/**
 * Curadores e avaliadores de um evento (EventMembership).
 * Servidor: só admin ou o GERENTE do evento concede/revoga; sem conta o
 * convite é enviado e o vínculo nasce no primeiro acesso.
 */
async function invoke(payload) {
  const res = await base44.functions.invoke("manageEventRole", payload);
  return res.data ?? res;
}

export function eventRoleErrorMessage(err) {
  return (
    err?.response?.data?.error ||
    err?.data?.error ||
    err?.message ||
    "Não foi possível concluir a operação."
  );
}

export async function listEventRoles(eventId) {
  const out = await invoke({ action: "list", event_id: eventId });
  return {
    memberships: out.memberships || [],
    invites: out.invites || [],
  };
}

export async function grantEventRole({ eventId, role, email, fullName }) {
  return invoke({ action: "grant", event_id: eventId, role, email, full_name: fullName || "" });
}

export async function revokeEventRole({ eventId, role, membershipId, inviteId }) {
  return invoke({
    action: "revoke",
    event_id: eventId,
    role,
    membership_id: membershipId || "",
    invite_id: inviteId || "",
  });
}