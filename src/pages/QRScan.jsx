import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { useNavigate } from "react-router-dom";
import QRScanner from "@/components/participante/QRScanner";
import PartnerVisitModal from "@/components/participante/PartnerVisitModal";
import TopAppBar from "@/components/layout/TopAppBar";
import EmptyState from "@/components/ui/EmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import { QrCode, Calendar } from "lucide-react";
import { toast } from "sonner";
import { t } from "@/lib/i18n";

export default function QRScan() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanPartnerId, setScanPartnerId] = useState(null);
  const [selectedEventId, setSelectedEventId] = useState(null);

  // P0: Server-side filter by email — returns 0 or 1 record, not all Persons
  const { data: myPerson, isLoading: personLoading } = useQuery({
    queryKey: ["my_person_qr", user?.email],
    queryFn: async () => {
      const matches = await base44.entities.Person.filter({ contact_email: user?.email });
      return matches[0] || null;
    },
    enabled: !!user,
  });

  // P0: Server-side filter by email — returns only the user's participants, not all
  const { data: participantsByEmail = [], isLoading: loadingByEmail } = useQuery({
    queryKey: ["my_participants_email", user?.email],
    queryFn: () => base44.entities.Participant.filter({ email: user?.email, is_deleted: false }),
    enabled: !!user,
  });

  // P0: Server-side filter by person_id — returns only the user's participants, not all
  const { data: participantsByPerson = [], isLoading: loadingByPerson } = useQuery({
    queryKey: ["my_participants_person", myPerson?.id],
    queryFn: () => base44.entities.Participant.filter({ person_id: myPerson.id, is_deleted: false }),
    enabled: !!myPerson?.id,
  });

  // Merge + deduplicate (email match OR person_id match — same selection logic as before)
  const myParticipants = useMemo(() => {
    const map = new Map();
    [...participantsByEmail, ...participantsByPerson].forEach((p) => map.set(p.id, p));
    return Array.from(map.values());
  }, [participantsByEmail, participantsByPerson]);

  const myEventIds = useMemo(
    () => [...new Set(myParticipants.map((p) => p.event_id))],
    [myParticipants]
  );

  // P0: Server-side filter by status active — bounded set, not all events
  const { data: events = [], isLoading: loadingEvents } = useQuery({
    queryKey: ["my_active_events_qr", myEventIds.join(",")],
    queryFn: async () => {
      if (!myEventIds.length) return [];
      const active = await base44.entities.Event.filter({ status: "active", is_deleted: false });
      const idSet = new Set(myEventIds);
      return active.filter((e) => idSet.has(e.id));
    },
    enabled: myEventIds.length > 0,
  });

  const isLoading = personLoading || loadingByEmail || (!!myPerson && loadingByPerson);

  // Auto-open scanner when exactly one active event
  useEffect(() => {
    if (!loadingEvents && events.length === 1 && !scannerOpen && !scanPartnerId) {
      setSelectedEventId(events[0].id);
      setScannerOpen(true);
    }
  }, [loadingEvents, events, scannerOpen, scanPartnerId]);

  const myParticipantForEvent = (eventId) =>
    myParticipants.find((p) => p.event_id === eventId);

  const extractPartnerId = (raw) => {
    try {
      const u = new URL(raw);
      return u.searchParams.get("partner_scan");
    } catch {
      return null;
    }
  };

  const isValidPartnerId = (id) => {
    // IDs são strings alfanuméricas de pelo menos 8 caracteres (UUID-like ou ObjectId)
    return typeof id === "string" && /^[a-zA-Z0-9_-]{8,}$/.test(id.trim());
  };

  const handleScan = (raw) => {
    setScannerOpen(false);
    const partnerId = extractPartnerId(raw) || raw;
    if (partnerId && isValidPartnerId(partnerId)) {
      setScanPartnerId(partnerId.trim());
    } else {
      toast.error("QR Code inválido. Tente novamente.");
    }
  };

  const handleSelectEvent = (eventId) => {
    setSelectedEventId(eventId);
    setScannerOpen(true);
  };

  if (isLoading || (myEventIds.length > 0 && loadingEvents)) {
    return (
      <>
        <TopAppBar title={t("nav.scanQR")} onBack={() => navigate(-1)} />
        <ListSkeleton count={3} />
      </>
    );
  }

  if (events.length === 0) {
    return (
      <>
        <TopAppBar title={t("nav.scanQR")} onBack={() => navigate(-1)} />
        <EmptyState
          icon={Calendar}
          title="Nenhum evento ativo"
          description="Você não está inscrito em nenhum evento ativo para escanear QR Codes."
        />
      </>
    );
  }

  return (
    <>
      <TopAppBar title={t("nav.scanQR")} onBack={() => navigate(-1)} />

      {events.length > 1 && !scannerOpen && !scanPartnerId && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Selecione o evento para escanear:</p>
          {events.map((event) => (
            <button
              key={event.id}
              onClick={() => handleSelectEvent(event.id)}
              className="flex items-center gap-3 p-4 rounded-xl border border-border bg-card hover:border-primary/40 hover:bg-surface transition-all w-full text-left"
            >
              {event.logo_url ? (
                <img src={event.logo_url} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
              ) : (
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold shrink-0"
                  style={{ backgroundColor: event.color_primary || "#4F46E5" }}
                >
                  {event.name?.[0]?.toUpperCase()}
                </div>
              )}
              <span className="font-medium truncate flex-1">{event.name}</span>
              <QrCode className="w-5 h-5 text-muted-foreground shrink-0" />
            </button>
          ))}
        </div>
      )}

      <QRScanner open={scannerOpen} onClose={() => setScannerOpen(false)} onScan={handleScan} />

      <PartnerVisitModal
        partnerId={scanPartnerId}
        eventId={selectedEventId}
        personId={myPerson?.id}
        participantId={myParticipantForEvent(selectedEventId)?.id}
        person={myPerson}
        isReadOnly={false}
        onClose={() => {
          setScanPartnerId(null);
          setSelectedEventId(null);
        }}
      />
    </>
  );
}