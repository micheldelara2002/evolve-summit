import { base44 } from "@/api/base44Client";

async function invoke(action, payload) {
  const response = await base44.functions.invoke("manageEventConfig", { action, ...payload });
  if (response?.data?.error) throw new Error(response.data.error);
  return response?.data || {};
}

export async function listEventConfig(entityName, eventId, options = {}) {
  const { records = [] } = await invoke("list", {
    entityName,
    eventId,
    includeDeleted: !!options.includeDeleted,
    activeOnly: !!options.activeOnly,
  });
  return records;
}

export async function createEventConfig(entityName, eventId, data) {
  const { record } = await invoke("create", { entityName, eventId, data });
  return record;
}

export async function updateEventConfig(entityName, eventId, id, data) {
  const { record } = await invoke("update", { entityName, eventId, id, data });
  return record;
}

export async function deleteEventConfig(entityName, eventId, id) {
  const { record } = await invoke("delete", { entityName, eventId, id });
  return record;
}
