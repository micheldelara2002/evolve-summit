export function isAdmin(user) {
  return user?.role === "admin";
}

export function canManageEvent(user, eventId) {
  if (isAdmin(user)) return true;
  if (user?.role === "manager") {
    const managedIds = user?.managed_event_ids || [];
    return managedIds.includes(eventId);
  }
  return false;
}

export function getEventFilter(user) {
  if (isAdmin(user)) return {};
  return {};
}

export function filterEventsByAccess(events, user) {
  if (isAdmin(user)) return events;
  const managedIds = user?.managed_event_ids || [];
  return events.filter(
    (e) => managedIds.includes(e.id) || e.manager_id === user?.id
  );
}