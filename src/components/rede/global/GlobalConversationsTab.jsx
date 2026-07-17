import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { MessageSquare, Loader2, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import PersonAvatar from "../PersonAvatar";
import EventBadge from "../EventBadge";
import ChatWindow from "../ChatWindow";
import ListSkeleton from "@/components/ui/ListSkeleton";
import EmptyState from "@/components/ui/EmptyState";
import { t } from "@/lib/i18n";

export default function GlobalConversationsTab({ eventIds, eventMap, myPerson, activeThreadId, onClearActiveThread }) {
  const [selectedThreadId, setSelectedThreadId] = useState(null);

  useEffect(() => {
    if (activeThreadId) {
      setSelectedThreadId(activeThreadId);
      onClearActiveThread();
    }
  }, [activeThreadId, onClearActiveThread]);

  const { data: threads = [], isLoading } = useQuery({
    queryKey: ["rede_global_threads", myPerson.id, eventIds.join(",")],
    queryFn: async () => {
      const [asA, asB] = await Promise.all([
        base44.entities.ChatThread.filter({ person_a_id: myPerson.id, is_deleted: false }),
        base44.entities.ChatThread.filter({ person_b_id: myPerson.id, is_deleted: false }),
      ]);
      const seen = new Set();
      const merged = [...asA, ...asB].filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
      return merged
        .filter((t) => eventIds.includes(t.event_id))
        .sort((a, b) => new Date(b.last_message_at || b.created_date) - new Date(a.last_message_at || a.created_date));
    },
  });

  const threadPersonIds = [...new Set(
    threads.flatMap((t) => [t.person_a_id, t.person_b_id]).filter((id) => id !== myPerson.id)
  )];
  const { data: persons = [] } = useQuery({
    queryKey: ["rede_persons_by_global_threads", threadPersonIds.join(",")],
    queryFn: async () => {
      if (!threadPersonIds.length) return [];
      return base44.entities.Person.filter({ id: { $in: threadPersonIds }, is_active: true });
    },
    enabled: threadPersonIds.length > 0,
  });
  const personMap = new Map(persons.map((p) => [p.id, p]));

  if (isLoading) return <ListSkeleton count={4} />;

  if (selectedThreadId) {
    const thread = threads.find((t) => t.id === selectedThreadId);
    const otherId = thread ? (thread.person_a_id === myPerson.id ? thread.person_b_id : thread.person_a_id) : null;
    const otherName = thread ? (thread.person_a_id === myPerson.id ? thread.person_b_name : thread.person_a_name) : "";
    const otherPerson = otherId ? personMap.get(otherId) : null;
    const threadEventId = thread?.event_id;
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setSelectedThreadId(null)} className="gap-1.5">
            <ArrowLeft className="w-4 h-4" /> {t("rede.back")}
          </Button>
          {threadEventId && <EventBadge eventName={eventMap.get(threadEventId)?.name} />}
        </div>
        <ChatWindow
          threadId={selectedThreadId}
          eventId={threadEventId}
          myPerson={myPerson}
          otherPerson={otherPerson || { full_name: otherName, id: otherId }}
          isReadOnly={false}
        />
      </div>
    );
  }

  if (threads.length === 0) {
    return <EmptyState icon={MessageSquare} title={t("rede.noConversations")} description={t("rede.noConversationsDesc")} />;
  }

  return (
    <div className="grid gap-2">
      {threads.map((thread) => {
        const otherId = thread.person_a_id === myPerson.id ? thread.person_b_id : thread.person_a_id;
        const otherName = thread.person_a_id === myPerson.id ? thread.person_b_name : thread.person_a_name;
        const person = personMap.get(otherId);
        return (
          <button
            key={thread.id}
            onClick={() => setSelectedThreadId(thread.id)}
            className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:bg-muted/50 transition-colors text-left"
          >
            <PersonAvatar person={person || { full_name: otherName }} />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm truncate">{otherName}</p>
              <div className="flex items-center gap-2">
                {thread.last_message_preview && (
                  <p className="text-xs text-muted-foreground truncate">{thread.last_message_preview}</p>
                )}
                <EventBadge eventName={eventMap.get(thread.event_id)?.name} />
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}