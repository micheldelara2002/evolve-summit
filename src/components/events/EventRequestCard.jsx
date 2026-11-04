import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CalendarDays, MapPin, Users, Check, X, ExternalLink, Ban } from "lucide-react";
import { Link } from "react-router-dom";

const STATUS_STYLES = {
  pending: "bg-warning/15 text-warning border-warning/30",
  approved: "bg-success/15 text-success border-success/30",
  rejected: "bg-destructive/15 text-destructive border-destructive/30",
  canceled: "bg-muted text-muted-foreground border-border",
};

const STATUS_LABELS = {
  pending: "Pendente",
  approved: "Aprovada",
  rejected: "Rejeitada",
  canceled: "Cancelada",
};

function formatRange(start, end) {
  if (!start) return "Sem data";
  const startDate = new Date(start).toLocaleDateString("pt-BR");
  if (!end) return startDate;
  return `${startDate} — ${new Date(end).toLocaleDateString("pt-BR")}`;
}

export default function EventRequestCard({ request, isAdmin, onApprove, onReject, onCancel, busy }) {
  const pending = request.status === "pending";

  return (
    <Card>
      <CardContent className="py-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold truncate">{request.name}</p>
            <p className="text-xs text-muted-foreground truncate">
              Solicitado por {request.requested_by_name || request.requested_by_email || "—"}
            </p>
          </div>
          <Badge variant="outline" className={`shrink-0 ${STATUS_STYLES[request.status] || ""}`}>
            {STATUS_LABELS[request.status] || request.status}
          </Badge>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <CalendarDays className="w-3.5 h-3.5" />
            {formatRange(request.start_date, request.end_date)}
          </span>
          {request.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5" />
              {request.location}
            </span>
          )}
          {request.expected_participants ? (
            <span className="inline-flex items-center gap-1">
              <Users className="w-3.5 h-3.5" />
              ~{request.expected_participants} pessoas
            </span>
          ) : null}
        </div>

        {request.notes && (
          <p className="text-sm text-muted-foreground line-clamp-3">{request.notes}</p>
        )}

        {request.review_notes && (
          <p className="text-xs rounded-lg bg-muted/50 px-3 py-2">
            <span className="font-medium">Administrador:</span> {request.review_notes}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {isAdmin && pending && (
            <>
              <Button size="sm" className="gap-1" onClick={() => onApprove(request)} disabled={busy}>
                <Check className="w-3.5 h-3.5" /> Aprovar
              </Button>
              <Button size="sm" variant="outline" className="gap-1 text-destructive" onClick={() => onReject(request)} disabled={busy}>
                <X className="w-3.5 h-3.5" /> Rejeitar
              </Button>
            </>
          )}

          {!isAdmin && pending && (
            <Button size="sm" variant="ghost" className="gap-1 text-muted-foreground" onClick={() => onCancel(request)} disabled={busy}>
              <Ban className="w-3.5 h-3.5" /> Cancelar solicitação
            </Button>
          )}

          {request.created_event_id && (
            <Link to={`/events/${request.created_event_id}`}>
              <Button size="sm" variant="outline" className="gap-1">
                <ExternalLink className="w-3.5 h-3.5" /> Abrir evento
              </Button>
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}