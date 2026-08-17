import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Search, UserPlus, Check, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PersonAvatar from "../PersonAvatar";
import EventBadge from "../EventBadge";
import ListSkeleton from "@/components/ui/ListSkeleton";
import EmptyState from "@/components/ui/EmptyState";
import { sendConnectionRequest } from "@/lib/redeService";
import { toast } from "sonner";
import { t } from "@/lib/i18n";

export default function GlobalDiscoverTab({ eventIds, eventMap, myPerson, myParticipantRecords, selectedEventId }) {
  const [search, setSearch] = useState("");
  const [pendingIds, setPendingIds] = useState(new Set());
  const queryClient = useQueryClient();

  const { data: participants = [], isLoading } = useQuery({
    queryKey: ["rede_global_participants", eventIds.join(",")],
    queryFn: async () => {
      if (!eventIds.length) return [];
      return base44.entities.Participant.filter({ event_id: { $in: eventIds }, is_deleted: false });
    },
    enabled: eventIds.length > 0,
  });

  const participantPersonIds = [...new Set(participants.map((p) => p.person_id).filter(Boolean))];
  const { data: persons = [] } = useQuery({
    queryKey: ["rede_persons_by_participants", participantPersonIds.join(",")],
    queryFn: async () => {
      if (!participantPersonIds.length) return [];
      return base44.entities.Person.filter({ id: { $in: participantPersonIds }, is_active: true });
    },
    enabled: participantPersonIds.length > 0,
  });

  const { data: mySentRequests = [] } = useQuery({
    queryKey: ["rede_global_sent_requests", myPerson.id, eventIds.join(",")],
    queryFn: async () => {
      const all = await base44.entities.ConnectionRequest.filter({ requester_person_id: myPerson.id, is_deleted: false });
      return all.filter((r) => eventIds.includes(r.event_id));
    },
  });

  const { data: myConnections = [] } = useQuery({
    queryKey: ["rede_global_connections", myPerson.id, eventIds.join(",")],
    queryFn: async () => {
      const [asA, asB] = await Promise.all([
        base44.entities.Connection.filter({ person_a_id: myPerson.id, is_deleted: false }),
        base44.entities.Connection.filter({ person_b_id: myPerson.id, is_deleted: false }),
      ]);
      const seen = new Set();
      const merged = [...asA, ...asB].filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
      return merged.filter((c) => eventIds.includes(c.event_id));
    },
  });

  const connectedIds = new Set(
    myConnections.flatMap((c) => [c.person_a_id, c.person_b_id]).filter((id) => id !== myPerson.id)
  );
  const sentIds = new Set(mySentRequests.filter((r) => r.status === "pending").map((r) => r.receiver_person_id));
  const personMap = new Map(persons.map((p) => [p.id, p]));

  // Deduplicate by person_id, track shared events
  const eligible = useMemo(() => {
    const byPersonId = new Map();
    participants
      .filter((p) => p.person_id && p.person_id !== myPerson.id)
      .forEach((p) => {
        if (!byPersonId.has(p.person_id)) {
          byPersonId.set(p.person_id, { person: personMap.get(p.person_id), sharedEventIds: [] });
        }
        byPersonId.get(p.person_id).sharedEventIds.push(p.event_id);
      });
    return [...byPersonId.values()].filter((e) => e.person);
  }, [participants, personMap, myPerson.id]);

  const filtered = eligible.filter((e) => !search || e.person.full_name?.toLowerCase().includes(search.toLowerCase()));

  const handleConnect = async (person, sharedEventIds) => {
    const connectEventId = selectedEventId !== "all" ? selectedEventId : sharedEventIds[0];
    if (!connectEventId) return;
    setPendingIds((prev) => new Set(prev).add(person.id));
    try {
      const myPart = myParticipantRecords.find((p) => p.event_id === connectEventId);
      const result = await sendConnectionRequest({
        eventId: connectEventId,
        requesterPerson: myPerson,
        receiverPerson: person,
        requesterParticipantId: myPart?.id,
      });
      if (result.ok) {
        toast.success(result.reason === "auto_accepted" ? t("rede.autoAccepted") : t("rede.requestSent"));
        queryClient.invalidateQueries({ queryKey: ["rede_global_sent_requests"] });
        queryClient.invalidateQueries({ queryKey: ["rede_global_connections"] });
        queryClient.invalidateQueries({ queryKey: ["rede_global_all_requests"] });
      } else {
        toast.info(
          result.reason === "already_connected" ? t("rede.alreadyConnected") :
          result.reason === "already_pending" ? t("rede.alreadyPending") :
          t("rede.requestSendError")
        );
      }
    } catch (e) {
      toast.error(t("rede.requestSendError") + ": " + e.message);
    } finally {
      setPendingIds((prev) => { const n = new Set(prev); n.delete(person.id); return n; });
    }
  };

  if (isLoading) return <ListSkeleton count={4} />;

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder={t("rede.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Users}
          title={search ? t("rede.noPeopleFound") : t("rede.noPeopleAvailable")}
        />
      ) : (
        <div className="grid gap-2">
          {filtered.map(({ person, sharedEventIds }) => {
            const isConnected = connectedIds.has(person.id);
            const isSent = sentIds.has(person.id);
            const isPending = pendingIds.has(person.id);
            return (
              <div key={person.id} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
                <PersonAvatar person={person} />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{person.full_name}</p>
                  <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                    {sharedEventIds.slice(0, 2).map((eid) => (
                      <EventBadge key={eid} eventName={eventMap.get(eid)?.name} />
                    ))}
                    {sharedEventIds.length > 2 && (
                      <span className="text-[10px] text-muted-foreground">+{sharedEventIds.length - 2}</span>
                    )}
                  </div>
                </div>
                {isConnected ? (
                  <span className="flex items-center gap-1 text-xs text-secondary font-medium shrink-0">
                    <Check className="w-3.5 h-3.5" /> {t("rede.connected")}
                  </span>
                ) : isSent ? (
                  <span className="text-xs text-muted-foreground shrink-0">{t("rede.pending")}</span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isPending}
                    onClick={() => handleConnect(person, sharedEventIds)}
                    className="shrink-0 h-11 sm:h-8 min-w-[44px] touch-manipulation"
                  >
                    {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                    {t("rede.connect")}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}