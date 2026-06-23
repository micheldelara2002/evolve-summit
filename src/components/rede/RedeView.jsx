import { useState } from "react";
import { UserPlus, Inbox, Users, MessageSquare } from "lucide-react";
import DiscoverTab from "./DiscoverTab";
import RequestsTab from "./RequestsTab";
import ConnectionsTab from "./ConnectionsTab";
import ConversationsTab from "./ConversationsTab";

const TABS = [
  { key: "descobrir", label: "Descobrir", icon: UserPlus },
  { key: "pedidos", label: "Pedidos", icon: Inbox },
  { key: "conexoes", label: "Conexões", icon: Users },
  { key: "conversas", label: "Conversas", icon: MessageSquare },
];

export default function RedeView({ eventId, myPerson, myParticipant, user, isReadOnly }) {
  const [activeTab, setActiveTab] = useState("descobrir");
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
    setActiveTab("conversas");
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-1 overflow-x-auto scrollbar-hide border-b border-border">
        {TABS.map(({ key, label, icon: Icon }) => {
          const active = activeTab === key;
          return (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap shrink-0
                ${active ? "text-foreground border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      {activeTab === "descobrir" && (
        <DiscoverTab eventId={eventId} myPerson={myPerson} isReadOnly={isReadOnly} />
      )}
      {activeTab === "pedidos" && (
        <RequestsTab eventId={eventId} myPerson={myPerson} myParticipant={myParticipant} user={user} isReadOnly={isReadOnly} />
      )}
      {activeTab === "conexoes" && (
        <ConnectionsTab eventId={eventId} myPerson={myPerson} isReadOnly={isReadOnly} onStartChat={handleStartChat} />
      )}
      {activeTab === "conversas" && (
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