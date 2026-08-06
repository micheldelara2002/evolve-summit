import { useState } from "react";
import { Megaphone, ChevronDown, ChevronRight, Clock, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * Painel de Triagem — sessões vindas do CFP (possuem submission_id)
 * que ainda não foram incorporadas à grade (sem sala, trilha ou horário).
 * Duplo clique abre o formulário de sessão já preenchido.
 */
export default function PendingCFPSessions({ sessions, tracks, rooms, onEdit }) {
  const [open, setOpen] = useState(true);

  const pending = sessions.filter(
    (s) => s.submission_id && (!s.room_id || !s.start_time || !s.track_id)
  );

  if (pending.length === 0) return null;

  const typeLabel = (val) => {
    const map = {
      aula: "Aula", debate: "Debate", demonstracao: "Demonstração", keynote: "Keynote",
      mesa_redonda: "Mesa redonda", palestra: "Palestra", painel: "Painel",
      simulacao: "Simulação", workshop: "Workshop",
    };
    return map[val] || val || "—";
  };

  return (
    <div className="rounded-2xl border border-secondary/30 bg-secondary/5 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 hover:bg-secondary/10 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Megaphone className="w-4 h-4 text-secondary" />
          <span className="text-sm font-display font-semibold">
            Submissões aprovadas pendentes de grade
          </span>
          <Badge variant="secondary" className="ml-1">{pending.length}</Badge>
        </div>
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          <p className="text-xs text-muted-foreground px-1 pb-1">
            Dê um duplo clique para abrir o cadastro e designar sala, trilha, data e horário.
          </p>
          {pending.map((s) => (
            <div
              key={s.id}
              onDoubleClick={() => onEdit(s)}
              className="flex items-start gap-3 p-3 rounded-xl border border-border bg-card cursor-pointer hover:border-primary/40 hover:shadow-sm transition-all"
              title="Duplo clique para agendar"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="font-medium truncate">{s.title}</h4>
                  <Badge variant="secondary" className="text-[10px] capitalize">{typeLabel(s.session_type)}</Badge>
                </div>
                {s.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{s.description}</p>
                )}
                <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                  {s.speaker_name && (
                    <span className="flex items-center gap-1"><User className="w-3 h-3" /> {s.speaker_name}</span>
                  )}
                  <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Sem horário</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}