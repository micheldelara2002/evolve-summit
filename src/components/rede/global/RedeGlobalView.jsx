import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import SectionSwitcher from "@/components/ui/SectionSwitcher";
import { useSectionParam } from "@/lib/useSectionParam";
import PullToRefresh from "@/components/ui/PullToRefresh";

const SECTIONS = [
  { id: "discover", labelKey: "rede.discover", icon: UserPlus },
  { id: "requests", labelKey: "rede.requests", icon: Inbox },
  { id: "connections", labelKey: "rede.connections", icon: Users },
  { id: "conversations", labelKey: "rede.conversations", icon: MessageSquare },
];

const LEGACY_TAB_MAP = {
  descobrir: "discover",
  pedidos: "requests",
  conexoes: "connections",
  conversas: "conversations",
};

export default function RedeGlobalView() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useSectionParam({ defaultSection: "discover", legacyTabMap: LEGACY_TAB_MAP });
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [selectedEventId, setSelectedEventId] = useState("all");

  const handleRefresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["my_person_rede_global"] }),
      queryClient.invalidateQueries({ queryKey: ["my_participants_rede_global"] }),
      queryClient.invalidateQueries({ queryKey: ["my_events_rede_global"] }),
      queryClient.invalidateQueries({ queryKey: ["rede_global"] }),
      queryClient.invalidateQueries({ queryKey: ["rede_persons_by_participants"] }),
    ]);
  };

  const { data: myPerson, isLoading: loadingPerson } = useQuery({
    queryKey: ["my_person_rede_global", user?.person_id, user?.email],
    queryFn: async () => {
      if (user?.person_id) {
        const list = await base44.entities.Person.filter({ id: user.person_id });
        if (list[0]) return list[0];
      }
      const byEmail = await base44.entities.Person.filter({ contact_email: user.email, is_active: true });
      return byEmail[0] || null;
    },
    enabled: !!user,
  });

  const { data: myParticipantRecords = [], isLoading: loadingParticipants } = useQuery({
    queryKey: ["my_participants_rede_global", user?.email, myPerson?.id],
    queryFn: async () => {
      const [byEmail, byPerson] = await Promise.all([
        base44.entities.Participant.filter({ email: user.email, is_deleted: false }),
        myPerson?.id
          ? base44.entities.Participant.filter({ person_id: myPerson.id, is_deleted: false })
          : [],
      ]);
      const seen = new Set();
      return [...byEmail, ...byPerson].filter((p) => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });
    },
    enabled: !!user && !!myPerson,
  });

  const myEventIds = useMemo(
    () => [...new Set(myParticipantRecords.map((p) => p.event_id))],
    [myParticipantRecords]
  );

  const { data: events = [] } = useQuery({
    queryKey: ["my_events_rede_global", myEventIds.join(",")],
    queryFn: async () => {
      if (!myEventIds.length) return [];
      return base44.entities.Event.filter({ id: { $in: myEventIds }, is_deleted: false });
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
    setActiveTab("conversations");
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

      <SectionSwitcher
        sections={SECTIONS.map((s) => ({ ...s, label: t(s.labelKey) }))}
        activeSection={activeTab}
        onSectionChange={setActiveTab}
      />

      <PullToRefresh onRefresh={handleRefresh} disabled={activeTab === "conversations"}>
        {activeTab === "discover" && (
          <GlobalDiscoverTab
            eventIds={effectiveEventIds}
            eventMap={eventMap}
            myPerson={myPerson}
            myParticipantRecords={myParticipantRecords}
            selectedEventId={selectedEventId}
          />
        )}
        {activeTab === "requests" && (
          <GlobalRequestsTab
            eventIds={effectiveEventIds}
            eventMap={eventMap}
            myPerson={myPerson}
            myParticipantRecords={myParticipantRecords}
          />
        )}
        {activeTab === "connections" && (
          <GlobalConnectionsTab
            eventIds={effectiveEventIds}
            eventMap={eventMap}
            myPerson={myPerson}
            myParticipantRecords={myParticipantRecords}
            onStartChat={handleStartChat}
          />
        )}
        {activeTab === "conversations" && (
          <GlobalConversationsTab
            eventIds={effectiveEventIds}
            eventMap={eventMap}
            myPerson={myPerson}
            activeThreadId={activeThreadId}
            onClearActiveThread={() => setActiveThreadId(null)}
          />
        )}
      </PullToRefresh>
    </div>
  );
}