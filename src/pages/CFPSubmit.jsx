/**
 * Formulário de submissão para uma Call for Papers específica.
 * - Resolve/cria a Person do usuário (potencial palestrante).
 * - Renderiza campos fixos (título, resumo, tipo) + campos customizados do form_config.
 * - Suporta edição (?edit=submissionId) e criação.
 * - Bloqueia edição se a chamada encerrou.
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ArrowLeft, Send } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";

const SESSION_TYPES = [
  { value: "palestra", label: "Palestra" },
  { value: "workshop", label: "Workshop" },
  { value: "keynote", label: "Keynote" },
  { value: "painel", label: "Painel" },
  { value: "mesa_redonda", label: "Mesa redonda" },
  { value: "debate", label: "Debate" },
  { value: "aula", label: "Aula" },
  { value: "demonstracao", label: "Demonstração" },
  { value: "simulacao", label: "Simulação" },
];

function parseJSON(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export default function CFPSubmit() {
  const { cfpId } = useParams();
  const [searchParams] = useSearchParams();
  const editId = searchParams.get("edit");
  const navigate = useNavigate();
  const { user } = useAuth();
  const qc = useQueryClient();

  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [proposedType, setProposedType] = useState("palestra");
  const [answers, setAnswers] = useState({});

  const { data: cfp } = useQuery({
    queryKey: ["cfp", cfpId],
    queryFn: async () => {
      const list = await base44.entities.CallForPapers.filter({ id: cfpId, is_deleted: false });
      return list[0];
    },
  });

  const { data: event } = useQuery({
    queryKey: ["cfp-event", cfp?.event_id],
    queryFn: async () => {
      const list = await base44.entities.Event.filter({ id: cfp.event_id });
      return list[0];
    },
    enabled: !!cfp?.event_id,
  });

  // Person do usuário (cria se não existir)
  const { data: person } = useQuery({
    queryKey: ["my-person", user?.person_id, user?.email],
    queryFn: async () => {
      if (user?.person_id) {
        const list = await base44.entities.Person.filter({ id: user.person_id });
        if (list[0]) return list[0];
      }
      if (user?.email) {
        const byEmail = await base44.entities.Person.filter({ contact_email: user.email });
        if (byEmail[0]) return byEmail[0];
      }
      return null;
    },
    enabled: !!user,
  });

  // Edição: carrega submission existente
  const { data: existing } = useQuery({
    queryKey: ["submission-edit", editId],
    queryFn: async () => {
      const list = await base44.entities.Submission.filter({ id: editId, is_deleted: false });
      return list[0];
    },
    enabled: !!editId,
  });

  useEffect(() => {
    if (existing) {
      setTitle(existing.title || "");
      setSummary(existing.summary || "");
      setProposedType(existing.proposed_type || "palestra");
      setAnswers(parseJSON(existing.custom_answers, {}));
    }
  }, [existing]);

  const fields = parseJSON(cfp?.form_config, []);
  const closed = cfp?.end_date && new Date(cfp.end_date) < new Date();
  const readOnly = !!editId && closed;

  const ensurePerson = async () => {
    if (person) return person;
    const created = await base44.entities.Person.create({
      full_name: user.full_name || user.email,
      contact_email: user.email,
    });
    await base44.auth.updateMe({ person_id: created.id });
    return created;
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const p = await ensurePerson();
      const payload = {
        call_for_papers_id: cfpId,
        event_id: cfp.event_id,
        person_id: p.id,
        submitter_name: p.full_name || user.full_name,
        submitter_email: p.contact_email || user.email,
        status: "pending",
        title: title.trim(),
        summary: summary.trim(),
        proposed_type: proposedType,
        custom_answers: JSON.stringify(answers),
      };
      if (editId) {
        return base44.entities.Submission.update(editId, {
          title: title.trim(),
          summary: summary.trim(),
          proposed_type: proposedType,
          custom_answers: JSON.stringify(answers),
        });
      }
      return base44.entities.Submission.create(payload);
    },
    onSuccess: () => {
      qc.invalidateQueries(["my-submissions"]);
      qc.invalidateQueries(["cfp-submissions"]);
      navigate("/speaker-dashboard");
    },
  });

  const submit = () => {
    if (!title.trim() || !summary.trim()) return;
    const missing = fields.find((f) => f.required && (answers[f.label] === undefined || answers[f.label] === ""));
    if (missing) return;
    saveMutation.mutate();
  };

  if (!cfp) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <Button variant="ghost" size="sm" className="gap-1" onClick={() => navigate(-1)}>
        <ArrowLeft className="w-4 h-4" /> Voltar
      </Button>

      <PageHeader icon={Send } title={cfp.title} subtitle={event?.name} tone="secondary" />

      {closed && (
        <div className="rounded-lg bg-warning/10 text-warning text-sm px-3 py-2">
          {editId ? "Esta chamada encerrou. Edição em somente leitura." : "Esta chamada encerrou. Não é mais possível submeter."}
        </div>
      )}

      {cfp.description && (
        <div className="rounded-xl bg-muted/40 p-3 text-sm text-muted-foreground">{cfp.description}</div>
      )}

      <div className={`space-y-4 ${readOnly ? "pointer-events-none opacity-60" : ""}`}>
        <div className="space-y-1.5">
          <Label>Título da palestra *</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex: Como escalar produtos em 2026" />
        </div>

        <div className="space-y-1.5">
          <Label>Resumo *</Label>
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} placeholder="Descreva brevemente o conteúdo, objetivos e o que o público vai aprender..." />
        </div>

        <div className="space-y-1.5">
          <Label>Tipo de sessão</Label>
          <Select value={proposedType} onValueChange={setProposedType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {SESSION_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {fields.length > 0 && (
          <div className="space-y-3 pt-2 border-t border-border">
            <h3 className="text-sm font-semibold">Perguntas adicionais</h3>
            {fields.map((f, i) => (
              <div key={i} className="space-y-1.5">
                <Label>{f.label} {f.required && <span className="text-destructive">*</span>}</Label>
                {f.type === "text" && (
                  <Input
                    value={answers[f.label] || ""}
                    onChange={(e) => setAnswers({ ...answers, [f.label]: e.target.value })}
                  />
                )}
                {f.type === "textarea" && (
                  <Textarea
                    value={answers[f.label] || ""}
                    onChange={(e) => setAnswers({ ...answers, [f.label]: e.target.value })}
                    rows={3}
                  />
                )}
                {f.type === "boolean" && (
                  <Switch checked={!!answers[f.label]} onCheckedChange={(v) => setAnswers({ ...answers, [f.label]: v })} />
                )}
                {f.type === "select" && (
                  <Select value={answers[f.label] || ""} onValueChange={(v) => setAnswers({ ...answers, [f.label]: v })}>
                    <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                    <SelectContent>
                      {(f.options || []).map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ))}
          </div>
        )}

        {!closed && (
          <Button onClick={submit} disabled={saveMutation.isPending} className="w-full gap-1">
            {saveMutation.isPending ? "Enviando..." : editId ? "Atualizar submissão" : "Enviar submissão"}
          </Button>
        )}
      </div>
    </div>
  );
}