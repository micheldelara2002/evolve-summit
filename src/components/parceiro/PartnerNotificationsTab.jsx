/**
 * Notificações no contexto do parceiro.
 * Reusa NotificationsCenter com scopeType="event" + partnerId.
 * Permite enviar para: todos do evento | apenas leads do parceiro.
 */
import NotificationsCenter from "@/components/notifications/NotificationsCenter";

export default function PartnerNotificationsTab({ eventId, partnerId, user, isReadOnly }) {
  return (
    <NotificationsCenter
      scopeType="event"
      scopeEventId={eventId}
      partnerId={partnerId}
      isReadOnly={isReadOnly}
      metricsPath={`/events/${eventId}/notifications/metrics`}
    />
  );
}