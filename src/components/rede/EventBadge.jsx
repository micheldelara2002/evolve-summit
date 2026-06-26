import { Badge } from "@/components/ui/badge";

/** Small badge showing the event context for a connection/conversation. */
export default function EventBadge({ eventName }) {
  if (!eventName) return null;
  return (
    <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground shrink-0 max-w-[120px] truncate">
      {eventName}
    </Badge>
  );
}