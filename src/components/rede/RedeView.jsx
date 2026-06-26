import { useState } from "react";
import { UserPlus, Inbox, Users, MessageSquare } from "lucide-react";
import DiscoverTab from "./DiscoverTab";
import RequestsTab from "./RequestsTab";
import ConnectionsTab from "./ConnectionsTab";
import ConversationsTab from "./ConversationsTab";
import SectionSwitcher from "@/components/ui/SectionSwitcher";
import { useSectionParam } from "@/lib/useSectionParam";
import { t } from "@/lib/i18n";

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

export default function RedeView({ eventId, myPerson, myParticipant, user, isReadOnly }) {
  const [activeTab, setActiveTab] = useSectionParam({ defaultSection: "discover", legacyTabMap: LEGACY_TAB_MAP });
  const [activeThreadId, setActiveThreadId] = useState(null);

  if (!myPerson) {
    return (
      <div className="text-center py-16 space-y-3">
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto">
          <Users className="w-8 h-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-display font-semibold">Perfil necessário</h3>
        <p className="text-sm text-muted-foreground max-w-xs mx-auto">
          Você precisa ter um perfil de pessoa cadastrado para usar a Rede. Complete seu perfil para começar.
        </p>
      </div>
    );
  }

  const handleStartChat = (threadId) => {
    setActiveThreadId(threadId);
    setActiveTab("conversations");
  };

  return (
    <div className="space-y-4">
      <SectionSwitcher
        sections={SECTIONS.map((s) => ({ ...s, label: t(s.labelKey) }))}
        activeSection={activeTab}
        onSectionChange={setActiveTab}
      />

      {activeTab === "discover" && (
        <DiscoverTab eventId={eventId} myPerson={myPerson} isReadOnly={isReadOnly} />
      )}
      {activeTab === "requests" && (
        <RequestsTab eventId={eventId} myPerson={myPerson} myParticipant={myParticipant} user={user} isReadOnly={isReadOnly} />
      )}
      {activeTab === "connections" && (
        <ConnectionsTab eventId={eventId} myPerson={myPerson} isReadOnly={isReadOnly} onStartChat={handleStartChat} />
      )}
      {activeTab === "conversations" && (
        <ConversationsTab
          eventId={eventId}
          myPerson={myPerson}
          isReadOnly={isReadOnly}
          activeThreadId={activeThreadId}
          onClearActiveThread={() => setActiveThreadId(null)}
        />
      )}
    </div>
  );
}