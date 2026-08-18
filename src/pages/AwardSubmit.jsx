/**
 * Formulário de inscrição de case para uma premiação (AwardConfig).
 * - Renderiza campos fixos (título, resumo) + campos customizados do form_config.
 * - Chama manageAward.submitCase (que valida janela, cria Person, garante EventMembership{entrant}, cria AwardSubmission).
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Send } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";

function parseJSON(str, fallback) { if (!str) return fallback; try { return JSON.parse(str); } catch { return fallback; } }

export default function AwardSubmit() {
  const { awardId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [answers, setAnswers] = useState({});

  const { data: award } = useQuery({
    queryKey: ["award", awardId],
    queryFn: async () => { const list = await base44.entities.AwardConfig.filter({ id: awardId, is_deleted: false }); return list[0]; },
  });

  const { data: event } = useQuery({
    queryKey: ["award-event", award?.event_id],
    queryFn: async () => { const list = await base44.entities.Event.filter({ id: award.event_id }); return list[0]; },
    enabled: !!award?.event_id,
  });

  const fields = parseJSON(award?.form_config, []);
  const closed = award?.end_date && new Date(award.end_date) < new Date();
  const notOpen = award?.start_date && new Date(award.start_date) > new Date();

  const submitMutation = useMutation({
    mutationFn: () =>
      base44.functions.invoke("manageAward", {
        action: "submitCase",
        award_id: awardId,
        title: title.trim(),
        summary: summary.trim(),
        custom_answers: answers,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-award-submissions"] });
      qc.invalidateQueries({ queryKey: ["awards-open"] });
      navigate("/awards");
    },
  });

  const submit = () => {
    if (!title.trim() || !summary.trim()) return;
    const missing = fields.find((f) => f.required && (answers[f.label] === undefined || answers[f.label] === ""));
    if (missing) return;
    submitMutation.mutate();
  };

  if (!award) {
    return <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <Button variant="ghost" size="sm" className="gap-1" onClick={() => navigate(-1)}>
        <ArrowLeft className="w-4 h-4" /> Voltar
      </Button>

      <PageHeader icon={Send} title={award.title} subtitle={event?.name} tone="success" />

      {closed && (
        <div className="rounded-lg bg-warning/10 text-warning text-sm px-3 py-2">Esta premiação encerrou. Não é mais possível inscrever.</div>
      )}
      {notOpen && (
        <div className="rounded-lg bg-warning/10 text-warning text-sm px-3 py-2">As inscrições ainda não abriram.</div>
      )}

      {award.description && <div className="rounded-xl bg-muted/40 p-3 text-sm text-muted-foreground">{award.description}</div>}

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>Título do case *</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex: Como transformamos o onboarding" />
        </div>
        <div className="space-y-1.5">
          <Label>Resumo do case *</Label>
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} placeholder="Descreva o case, o problema, a solução e os resultados..." />
        </div>

        {fields.length > 0 && (
          <div className="space-y-3 pt-2 border-t border-border">
            <h3 className="text-sm font-semibold">Perguntas adicionais</h3>
            {fields.map((f, i) => (
              <div key={i} className="space-y-1.5">
                <Label>{f.label} {f.required && <span className="text-destructive">*</span>}</Label>
                {f.type === "text" && <Input value={answers[f.label] || ""} onChange={(e) => setAnswers({ ...answers, [f.label]: e.target.value })} />}
                {f.type === "textarea" && <Textarea value={answers[f.label] || ""} onChange={(e) => setAnswers({ ...answers, [f.label]: e.target.value })} rows={3} />}
                {f.type === "boolean" && <Switch checked={!!answers[f.label]} onCheckedChange={(v) => setAnswers({ ...answers, [f.label]: v })} />}
                {f.type === "select" && (
                  <Select value={answers[f.label] || ""} onValueChange={(v) => setAnswers({ ...answers, [f.label]: v })}>
                    <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                    <SelectContent>{(f.options || []).map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              </div>
            ))}
          </div>
        )}

        {!closed && !notOpen && (
          <Button onClick={submit} disabled={submitMutation.isPending} className="w-full gap-1">
            {submitMutation.isPending ? "Enviando..." : "Inscrever case"}
          </Button>
        )}
      </div>
    </div>
  );
}