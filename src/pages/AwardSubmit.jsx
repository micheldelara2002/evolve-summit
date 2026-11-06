/**
 * Formulário de inscrição de case para uma premiação (AwardConfig).
 * - Renderiza campos fixos (título, resumo) + campos customizados do form_config.
 * - Chama manageAward.submitCase (que valida janela, cria Person, garante EventMembership{entrant}, cria AwardSubmission).
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
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
  const [searchParams] = useSearchParams();
  const caseId = searchParams.get("case") || "";

  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [answers, setAnswers] = useState({});

  const { data: award } = useQuery({
    queryKey: ["award", awardId],
    queryFn: async () => {
      const response = await base44.functions.invoke("manageEventConfig", { action: "list", entityName: "AwardConfig", id: awardId });
      const list = response.data?.records || response.records || [];
      return list[0];
    },
  });

  const { data: event } = useQuery({
    queryKey: ["award-event", award?.event_id],
    queryFn: async () => { const list = await base44.entities.Event.filter({ id: award.event_id }); return list[0]; },
    enabled: !!award?.event_id,
  });

  // A-06: edição do próprio case pendente (?case=<id>).
  const { data: myCases = [], isLoading: loadingCases } = useQuery({
    queryKey: ["my-award-submissions"],
    queryFn: async () => {
      const res = await base44.functions.invoke("manageAward", { action: "myCases" });
      return res.data?.submissions || res.submissions || [];
    },
    enabled: !!caseId,
  });
  const editingCase = caseId ? myCases.find((c) => c.id === caseId) : null;

  const fields = parseJSON(award?.form_config, []);
  const closed = award?.end_date && new Date(award.end_date) < new Date();
  const notOpen = award?.start_date && new Date(award.start_date) > new Date();

  useEffect(() => {
    if (!editingCase || title || summary) return;
    setTitle(editingCase.title || "");
    setSummary(editingCase.summary || "");
    setAnswers(parseJSON(editingCase.custom_answers, {}));
  }, [editingCase]);

  const submitMutation = useMutation({
    mutationFn: () =>
      base44.functions.invoke("manageAward", {
        action: editingCase ? "updateCase" : "submitCase",
        submission_id: editingCase?.id,
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
    onError: (err) => {
      toast.error(err?.response?.data?.error || err?.data?.error || "Não foi possível salvar o case.");
    },
  });

  const submit = () => {
    if (!title.trim() || !summary.trim()) {
      toast.error("Preencha o título e o resumo do case.");
      return;
    }
    const missing = fields.find((f) => f.required && (answers[f.label] === undefined || answers[f.label] === ""));
    if (missing) {
      toast.error(`Responda: ${missing.label}`);
      return;
    }
    submitMutation.mutate();
  };

  if (caseId && loadingCases) {
    return <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }

  if (caseId && !editingCase) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <Button variant="ghost" size="sm" className="gap-1" onClick={() => navigate("/awards")}>
          <ArrowLeft className="w-4 h-4" /> Voltar
        </Button>
        <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          Case não encontrado entre as suas inscrições.
        </div>
      </div>
    );
  }

  if (!award) {
    return <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <Button variant="ghost" size="sm" className="gap-1" onClick={() => navigate(-1)}>
        <ArrowLeft className="w-4 h-4" /> Voltar
      </Button>

      <PageHeader icon={Send} title={award.title} subtitle={event?.name} tone="success" />

      {editingCase && (
        <div className="rounded-lg bg-primary/5 text-primary text-sm px-3 py-2">
          Editando um case pendente. Após a avaliação começar não é mais possível alterar.
        </div>
      )}

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
            {submitMutation.isPending ? "Salvando..." : editingCase ? "Salvar alterações" : "Inscrever case"}
          </Button>
        )}
      </div>
    </div>
  );
}