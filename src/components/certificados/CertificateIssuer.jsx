/**
 * Módulo de emissão de certificados (individual e em lote).
 * Usado na aba "Certificados" do EventDetail.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Award, Download, Mail, Users, Mic, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import CertificatePreview from "./CertificateTemplates";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

function generateHash() {
  return Math.random().toString(36).substring(2, 10).toUpperCase() +
    "-" + Math.random().toString(36).substring(2, 10).toUpperCase();
}

const TEMPLATES = [
  { value: "classico", label: "Clássico" },
  { value: "moderno", label: "Moderno" },
  { value: "minimalista", label: "Minimalista" },
];

async function downloadCertPDF(elementId, filename) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const canvas = await html2canvas(el, { scale: 2, useCORS: true });
  const imgData = canvas.toDataURL("image/png");
  const pdf = new jsPDF({ orientation: "landscape", unit: "px", format: [794, 562] });
  pdf.addImage(imgData, "PNG", 0, 0, 794, 562);
  pdf.save(`${filename}.pdf`);
}

// ── Preview + download modal ──────────────────────────────────────────────────
function CertPreviewModal({ open, onClose, event, person, session, tipo, template, hashCode, issuedByName, onSendEmail, sendingEmail }) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    await downloadCertPDF("cert-render", `certificado-${person?.full_name?.replace(/\s/g, "-")}`);
    setDownloading(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl w-full">
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            <Award className="w-5 h-5 text-primary" /> Pré-visualização do Certificado
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-x-auto">
          <div className="origin-top-left" style={{ transform: "scale(0.75)", transformOrigin: "top left", width: "794px", marginBottom: "-140px" }}>
            <CertificatePreview
              template={template}
              event={event}
              person={person}
              session={session}
              tipo={tipo}
              hashCode={hashCode}
              issuedByName={issuedByName}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <Button variant="outline" className="gap-2" onClick={handleDownload} disabled={downloading}>
            <Download className="w-4 h-4" />
            {downloading ? "Gerando PDF..." : "Baixar PDF"}
          </Button>
          <Button variant="outline" className="gap-2" onClick={onSendEmail} disabled={sendingEmail}>
            <Mail className="w-4 h-4" />
            {sendingEmail ? "Enviando..." : "Enviar por e-mail"}
          </Button>
          <Button variant="ghost" onClick={onClose} className="ml-auto">Fechar</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function CertificateIssuer({ eventId, event, user }) {
  const queryClient = useQueryClient();
  const [tipo, setTipo] = useState("participacao");
  const [template, setTemplate] = useState("classico");
  const [selectedParticipantId, setSelectedParticipantId] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [previewData, setPreviewData] = useState(null);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [batchStatus, setBatchStatus] = useState(null); // { total, done, errors }

  const { data: participants = [] } = useQuery({
    queryKey: ["participants", eventId],
    queryFn: () => base44.entities.Participant.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", eventId],
    queryFn: () => base44.entities.Session.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: certificates = [] } = useQuery({
    queryKey: ["certificates", eventId],
    queryFn: () => base44.entities.Certificate.filter({ event_id: eventId, is_deleted: false }),
  });

  const speakers = participants.filter((p) => p.role_in_event === "speaker");
  const attendees = participants.filter((p) => p.registration_status !== "cancelled");

  const issueMut = useMutation({
    mutationFn: async ({ participant, session, hashCode }) => {
      const existing = certificates.find(
        (c) => c.participant_id === participant.id && c.tipo === tipo && (tipo === "participacao" || c.session_id === session?.id)
      );
      if (existing) return existing;
      return base44.entities.Certificate.create({
        event_id: eventId,
        person_id: participant.person_id || "",
        participant_id: participant.id,
        session_id: session?.id || undefined,
        tipo,
        template,
        hash_code: hashCode || generateHash(),
        issued_by_user_id: user?.id,
        issued_by_name: user?.full_name,
        email_sent: false,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["certificates", eventId] }),
  });

  // Emissão individual
  const handleIssueIndividual = async () => {
    if (!selectedParticipantId) { toast.error("Selecione um participante."); return; }
    if (tipo === "palestra" && !selectedSessionId) { toast.error("Selecione uma sessão."); return; }

    const participant = participants.find((p) => p.id === selectedParticipantId);
    const session = sessions.find((s) => s.id === selectedSessionId);
    const hashCode = generateHash();

    const cert = await issueMut.mutateAsync({ participant, session, hashCode });

    // Buscar person para preview
    let person = null;
    if (participant.person_id) {
      const pList = await base44.entities.Person.filter({ id: participant.person_id });
      person = pList[0];
    }
    if (!person) person = { full_name: participant.full_name };

    setPreviewData({ cert, participant, person, session, hashCode: cert.hash_code });
  };

  // Emissão em lote
  const handleBatch = async () => {
    if (tipo === "palestra" && !selectedSessionId) { toast.error("Selecione uma sessão para emissão em lote de palestrante."); return; }

    const pool = tipo === "palestra"
      ? speakers.filter((p) => sessions.find((s) => s.id === selectedSessionId)?.speaker_id === p.id ? [p] : []).concat(
          // fallback: all speakers
          speakers
        ).slice(0, 1)
      : attendees;

    if (!pool.length) { toast.warning("Nenhum participante elegível."); return; }

    setBatchStatus({ total: pool.length, done: 0, errors: 0 });

    for (const participant of pool) {
      const session = tipo === "palestra" ? sessions.find((s) => s.id === selectedSessionId) : null;
      try {
        await issueMut.mutateAsync({ participant, session, hashCode: generateHash() });
        setBatchStatus((prev) => prev ? { ...prev, done: prev.done + 1 } : null);
      } catch {
        setBatchStatus((prev) => prev ? { ...prev, errors: prev.errors + 1 } : null);
      }
    }

    toast.success("Emissão em lote concluída!");
  };

  const handleSendEmail = async () => {
    if (!previewData) return;
    const { participant, person } = previewData;
    const email = person?.contact_email || participant?.email;
    if (!email) { toast.error("Participante sem e-mail cadastrado."); return; }

    setSendingEmail(true);
    try {
      const body = `Olá, ${person?.full_name}!\n\nSeu certificado do evento ${event?.name} está disponível.\n\nCódigo de validação: ${previewData.hashCode}\nValidar em: ${window.location.origin}/validate-certificate\n\nAtenciosamente,\n${user?.full_name || "Equipe do Evento"}`;
      await base44.integrations.Core.SendEmail({ to: email, subject: `Seu certificado — ${event?.name}`, body });
      await base44.entities.Certificate.update(previewData.cert.id, { email_sent: true, email_sent_at: new Date().toISOString() });
      queryClient.invalidateQueries({ queryKey: ["certificates", eventId] });
      toast.success("E-mail enviado com sucesso!");
    } catch {
      toast.error("Erro ao enviar e-mail.");
    } finally {
      setSendingEmail(false);
    }
  };

  const issuedCount = certificates.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-display font-semibold flex items-center gap-2">
            <Award className="w-4 h-4 text-primary" /> Emissão de Certificados
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">{issuedCount} certificado{issuedCount !== 1 ? "s" : ""} emitido{issuedCount !== 1 ? "s" : ""}</p>
        </div>
      </div>

      {/* Configurações */}
      <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Tipo */}
          <div className="space-y-1.5">
            <Label>Tipo de certificado</Label>
            <Select value={tipo} onValueChange={setTipo}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="participacao">
                  <div className="flex items-center gap-2"><Users className="w-4 h-4" /> Participação</div>
                </SelectItem>
                <SelectItem value="palestra">
                  <div className="flex items-center gap-2"><Mic className="w-4 h-4" /> Palestra</div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Template */}
          <div className="space-y-1.5">
            <Label>Template visual</Label>
            <Select value={template} onValueChange={setTemplate}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TEMPLATES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* Participante (individual) */}
          <div className="space-y-1.5">
            <Label>Participante (individual)</Label>
            <Select value={selectedParticipantId} onValueChange={setSelectedParticipantId}>
              <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
              <SelectContent>
                {(tipo === "palestra" ? speakers : attendees).map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Sessão (para palestra) */}
          {tipo === "palestra" && (
            <div className="space-y-1.5">
              <Label>Sessão/Palestra</Label>
              <Select value={selectedSessionId} onValueChange={setSelectedSessionId}>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {sessions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* Ações */}
        <div className="flex flex-wrap gap-3 pt-2">
          <Button onClick={handleIssueIndividual} disabled={issueMut.isPending} className="gap-2">
            <Award className="w-4 h-4" /> Emitir Individual
          </Button>
          <Button variant="outline" onClick={handleBatch} disabled={issueMut.isPending} className="gap-2">
            <Users className="w-4 h-4" /> Emitir em Lote
          </Button>
        </div>

        {/* Batch progress */}
        {batchStatus && (
          <div className="bg-muted/40 rounded-xl px-4 py-3 flex items-center gap-3 text-sm">
            {batchStatus.done + batchStatus.errors < batchStatus.total ? (
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            )}
            <span>
              {batchStatus.done}/{batchStatus.total} emitidos
              {batchStatus.errors > 0 && <span className="text-destructive ml-2">· {batchStatus.errors} erros</span>}
            </span>
          </div>
        )}
      </div>

      {/* Histórico */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Certificados emitidos</h3>
        {certificates.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-6">Nenhum certificado emitido ainda.</p>
        )}
        {certificates.slice(0, 30).map((cert) => {
          const participant = participants.find((p) => p.id === cert.participant_id);
          const session = sessions.find((s) => s.id === cert.session_id);
          return (
            <div key={cert.id} className="flex items-center gap-3 rounded-xl border border-border px-4 py-3 text-sm">
              <Award className="w-4 h-4 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{participant?.full_name || "—"}</p>
                <p className="text-xs text-muted-foreground">
                  {cert.tipo === "palestra" ? `Palestra: ${session?.title || "—"}` : "Participação"} · {cert.template}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {cert.email_sent && (
                  <span className="text-[10px] text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">E-mail enviado</span>
                )}
                <span className="font-mono text-[10px] text-muted-foreground">{cert.hash_code}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Preview modal */}
      {previewData && (
        <CertPreviewModal
          open={!!previewData}
          onClose={() => setPreviewData(null)}
          event={event}
          person={previewData.person}
          session={previewData.session}
          tipo={tipo}
          template={template}
          hashCode={previewData.hashCode}
          issuedByName={user?.full_name}
          onSendEmail={handleSendEmail}
          sendingEmail={sendingEmail}
        />
      )}
    </div>
  );
}