/**
 * usePollRealtime — subscription segura e scoped aos Session Polls (Lote Realtime Seguro).
 *
 * Inscreve em PollEvent (entidade com RLS recipient_emails contains {{user.email}}).
 * O RLS garante que o usuário só recebe eventos endereçados ao seu email — autorização
 * server-side. O filtro por session_id aqui é apenas scoping da view atual (não segurança).
 *
 * Comportamento:
 *   - poll_live / poll_closed → invalidate (refetch getSessionPolls). Infrequente.
 *   - poll_results → setQueryData com o payload agregado (sem refetch). Só speaker recebe.
 *
 * O polling agressivo (2s) foi removido; o fallback não-agressivo fica no refetchInterval
 * do useQuery (30s) no consumidor — para recovery de desconexão.
 *
 * NÃO acessa SessionPollAnswer diretamente. RLS das 5 entidades permanece intacto.
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";

export default function usePollRealtime(sessionId, queryKey) {
  const queryClient = useQueryClient();
  const qkRef = useRef(queryKey);
  qkRef.current = queryKey;

  useEffect(() => {
    if (!sessionId) return;
    const unsub = base44.entities.PollEvent.subscribe((event) => {
      const e = event?.data;
      if (!e || e.session_id !== sessionId) return; // scope à session atual
      const qk = qkRef.current;
      if (e.type === "poll_results") {
        let payload = {};
        try { payload = JSON.parse(e.payload || "{}"); } catch { payload = {}; }
        queryClient.setQueryData(qk, (old) => {
          const polls = Array.isArray(old) ? old : [];
          return polls.map((p) => {
            if (p.id !== e.poll_id) return p;
            const opts = (p.options || []).map((o) => ({
              ...o,
              count: payload.counts?.[o.id] ?? o.count,
            }));
            const totalVotes =
              payload.totalVotes ?? opts.reduce((s, o) => s + (o.count || 0), 0);
            return {
              ...p,
              totalVoters: payload.totalResponses ?? p.totalVoters,
              totalVotes,
              options: opts,
              status: p.status, // status via refetch (poll_live/closed), não pelo payload
            };
          });
        });
      } else {
        // poll_live | poll_closed → refetch autorizado (infrequente)
        queryClient.invalidateQueries({ queryKey: qk });
      }
    });
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, [sessionId, queryClient]);
}