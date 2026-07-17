import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PersonAvatar from "./PersonAvatar";
import { sendMessage } from "@/lib/redeService";
import { sanitizeText } from "@/utils/sanitize";
import { toast } from "sonner";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

export default function ChatWindow({ threadId, eventId, myPerson, otherPerson, isReadOnly }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const queryClient = useQueryClient();
  const scrollRef = useRef(null);

  const { data: messages = [], isLoading } = useQuery({
    queryKey: ["chat_messages", threadId],
    queryFn: () => base44.entities.ChatMessage.filter({ thread_id: threadId }),
    refetchInterval: 5000,
  });

  // Real-time subscription
  useEffect(() => {
    const unsub = base44.entities.ChatMessage.subscribe((event) => {
      if (event.data?.thread_id === threadId) {
        queryClient.invalidateQueries({ queryKey: ["chat_messages", threadId] });
      }
    });
    return unsub;
  }, [threadId, queryClient]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Mark messages from other person as read
  useEffect(() => {
    messages.forEach((m) => {
      if (m.sender_person_id !== myPerson.id && !m.read_at) {
        base44.entities.ChatMessage.update(m.id, { read_at: new Date().toISOString() });
      }
    });
  }, [messages, myPerson.id]);

  const handleSend = async (e) => {
    e?.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await sendMessage({
        threadId,
        eventId,
        senderPersonId: myPerson.id,
        senderName: myPerson.full_name,
        messageText: sanitizeText(trimmed),
      });
      setText("");
      queryClient.invalidateQueries({ queryKey: ["chat_messages", threadId] });
      queryClient.invalidateQueries({ queryKey: ["rede_threads"] });
    } catch (err) {
      toast.error("Erro ao enviar: " + err.message);
    } finally {
      setSending(false);
    }
  };

  const sorted = [...messages].sort((a, b) => new Date(a.created_date) - new Date(b.created_date));

  return (
    <div className="flex flex-col rounded-2xl border border-border bg-card overflow-hidden" style={{ height: "60vh" }}>
      {/* Header */}
      <div className="flex items-center gap-3 p-3 border-b border-border">
        <PersonAvatar person={otherPerson} size="sm" />
        <span className="font-semibold text-sm">{otherPerson?.full_name || "Conversa"}</span>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2">
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : sorted.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8">Diga olá! 👋</p>
        ) : (
          sorted.map((msg) => {
            const isMine = msg.sender_person_id === myPerson.id;
            return (
              <div key={msg.id} className={`flex ${isMine ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[75%] px-3 py-2 rounded-2xl text-sm ${
                  isMine ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-muted text-foreground rounded-bl-sm"
                }`}>
                  <p className="break-words whitespace-pre-wrap">{msg.message_text}</p>
                  <p className={`text-[10px] mt-0.5 ${isMine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                    {format(new Date(msg.created_date), "HH:mm", { locale: ptBR })}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="flex gap-2 p-3 border-t border-border">
        <Input
          placeholder="Digite uma mensagem..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={isReadOnly || sending}
          className="flex-1"
        />
        <Button type="submit" size="icon" disabled={isReadOnly || sending || !text.trim()}>
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </Button>
      </form>
    </div>
  );
}