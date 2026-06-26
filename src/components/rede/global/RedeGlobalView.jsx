import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { UserPlus, Inbox, Users, MessageSquare } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import GlobalDiscoverTab from "./GlobalDiscoverTab";
import GlobalRequestsTab from "./GlobalRequestsTab";
import GlobalConnectionsTab from "./GlobalConnectionsTab";
import GlobalConversationsTab from "./GlobalConversationsTab";
import ListSkeleton from "@/components/ui/ListSkeleton";
import EmptyState from "@/components/ui/EmptyState";
import { t } from "@/lib/i18n";

const TABS = [
  { key: "descobrir", labelKey: "rede.discover", icon: UserPlus },
  { key: "pedidos", labelKey: "rede.requests", icon: Inbox },
  { key: "conexoes", labelKey: "rede.connections", icon: Users },
  { key: "conversas", labelKey: "rede.conversations", icon: MessageSquare },
];

export default function RedeGlobalView() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState("descobrir");
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [selectedEventId, setSelectedEventId] = useState("all");

  const { data: myPerson, isLoading: loadingPerson } = useQuery({
    queryKey: ["my_person_rede_global", user?.person_id, user?.email],
    queryFn: async () => {
      if (user?.person_id) {
        const list = await base44.entities.Person.filter({ id: user.person_id });
        if (list[0]) return list[0];
      }
      const all = await base44.entities.Person.filter({ is_active: true });
      return all.find((p) => p.contact_email === user?.email) || null;
    },
    enabled: !!user,
  });

  const { data: allParticipants = [], isLoading: loadingParticipants } = useQuery({
    queryKey: ["all_participants_rede_global", user?.email],
    queryFn: () => base44.entities.Participant.filter({ is_deleted: false }),
    enabled: !!user,
  });

  // User's own participant records (across all events)
  const myParticipantRecords = useMemo(
    () =>
      allParticipants.filter(
        (p) => p.email === user?.email || (myPerson && p.person_id === myPerson?.id)
      ),
    [allParticipants, user?.email, myPerson]
  );

  const myEventIds = useMemo(
    () => [...new Set(myParticipantRecords.map((p) => p.event_id))],
    [myParticipantRecords]
  );

  const { data: events = [] } = useQuery({
    queryKey: ["my_events_rede_global", myEventIds.join(",")],
    queryFn: async () => {
      if (!myEventIds.length) return [];
      const all = await base44.entities.Event.filter({ is_deleted: false });
      return all.filter((e) => myEventIds.includes(e.id));
    },
    enabled: myEventIds.length > 0,
  });

  const eventMap = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);

  if (loadingPerson || loadingParticipants) return <ListSkeleton count={3} />;

  if (!myPerson) {
    return (
      <EmptyState
        icon={Users}
        title={t("rede.profileRequired")}
        description={t("rede.profileRequiredDesc")}
      />
    );
  }

  if (myEventIds.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title={t("rede.noEvents")}
        description={t("rede.noEventsDesc")}
      />
    );
  }

  const handleStartChat = (threadId) => {
    setActiveThreadId(threadId);
    setActiveTab("conversas");
  };

  const effectiveEventIds = selectedEventId === "all" ? myEventIds : [selectedEventId];

  return (
    <div className="space-y-4">
      {/* Event filter */}
      <Select value={selectedEventId} onValueChange={setSelectedEventId}>
        <SelectTrigger className="w-full sm:w-64 h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("rede.allEvents")}</SelectItem>
          {events.map((e) => (
            <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto scrollbar-hide border-b border-border">
        {TABS.map(({ key, labelKey, icon: Icon }) => {
          const active = activeTab === key;
          return (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap shrink-0
                ${active ? "text-foreground border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t(labelKey)}
            </button>
          );
        })}
      </div>

      {activeTab === "descobrir" && (
        <GlobalDiscoverTab
          eventIds={effectiveEventIds}
          eventMap={eventMap}
          myPerson={myPerson}
          myParticipantRecords={myParticipantRecords}
          selectedEventId={selectedEventId}
        />
      )}
      {activeTab === "pedidos" && (
        <GlobalRequestsTab
          eventIds={effectiveEventIds}
          eventMap={eventMap}
          myPerson={myPerson}
          myParticipantRecords={myParticipantRecords}
        />
      )}
      {activeTab === "conexoes" && (
        <GlobalConnectionsTab
          eventIds={effectiveEventIds}
          eventMap={eventMap}
          myPerson={myPerson}
          myParticipantRecords={myParticipantRecords}
          onStartChat={handleStartChat}
        />
      )}
      {activeTab === "conversas" && (
        <GlobalConversationsTab
          eventIds={effectiveEventIds}
          eventMap={eventMap}
          myPerson={myPerson}
          activeThreadId={activeThreadId}
          onClearActiveThread={() => setActiveThreadId(null)}
        />
      )}
    </div>
  );
}