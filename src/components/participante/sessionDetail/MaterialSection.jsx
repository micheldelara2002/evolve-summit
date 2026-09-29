/**
 * Seção de material da sessão: download do link e envio do material para o
 * e-mail de contato da própria Person.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sendEmail } from "@/lib/apiClient";
import { fetchMyPerson } from "@/lib/personApi";
import { Download, Mail, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

export default function MaterialSection({ session, participant }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  // Buscar person para pegar contact_email
  const { data: person } = useQuery({
    queryKey: ["participant-person", participant?.person_id],
    // Lote 4 — própria Person via backend (evita SDK direto em Person travada)
    queryFn: () => fetchMyPerson(),
    enabled: !!participant?.person_id,
  });

  const contactEmail = person?.contact_email;

  const handleSendEmail = async () => {
    if (!contactEmail) {
      toast.error("E-mail de contato não cadastrado. Acesse seu perfil e preencha o e-mail de contato.");
      return;
    }
    setSending(true);
    try {
      await sendEmail({
        to: contactEmail,
        subject: `Material da sessão: ${session.title}`,
        body: `Olá${participant?.full_name ? `, ${participant.full_name}` : ""}!\n\nAqui está o material da sessão "${session.title}":\n\n${session.material_url}\n\nBom aprendizado!`,
      });
      setSent(true);
      toast.success(`Material enviado para ${contactEmail}`);
    } catch {
      toast.error("Erro ao enviar e-mail. Tente novamente.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-2">
      <a
        href={session.material_url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 w-full px-4 py-2.5 rounded-xl border border-border bg-muted/30 text-sm font-medium hover:bg-muted/60 transition-colors"
      >
        <Download className="w-4 h-4 text-primary" />
        Baixar material da sessão
      </a>

      {sent ? (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          Material enviado para {contactEmail}
        </div>
      ) : (
        <button
          onClick={handleSendEmail}
          disabled={sending}
          className="flex items-center gap-2 w-full px-4 py-2.5 rounded-xl border border-border bg-muted/30 text-sm font-medium hover:bg-muted/60 transition-colors disabled:opacity-60"
        >
          {sending ? (
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          ) : (
            <Mail className="w-4 h-4 text-primary" />
          )}
          {sending ? "Enviando..." : "Enviar material por e-mail"}
        </button>
      )}
    </div>
  );
}