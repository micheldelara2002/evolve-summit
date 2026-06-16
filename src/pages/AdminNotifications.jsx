import NotificationsCenter from "@/components/notifications/NotificationsCenter";

export default function AdminNotifications() {
  return (
    <NotificationsCenter
      scopeType="global"
      scopeEventId={null}
      metricsPath="/notifications/metrics"
    />
  );
}