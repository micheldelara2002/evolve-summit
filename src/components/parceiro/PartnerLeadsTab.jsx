/**
 * Aba de Leads do parceiro no evento.
 * Lista leads (quem escaneou QR), exporta XLS e envia por e-mail.
 * P0 (2026-10-17) — Paginação por cursor: uma página de 100 por vez com
 * "Carregar mais"; exportação/e-mail percorrem TODAS as páginas explicitamente
 * (loop de cursor) no clique do usuário — nunca uma resposta gigante única.
 */
import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Download, Mail, Users, Lock } from "lucide-react";
import { toast } from "sonner";
import { sendEmail } from "@/lib/apiClient";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

const SOURCE_LABELS = {
  booth_scan: "Estande",
  session: "Palestra",
  networking: "Networking",
  manual: "Manual",
};

const QUALITY_COLORS = {
  hot: "bg-red-100 text-red-700",
  warm: "bg-amber-100 text-amber-700",
  cold: "bg-blue-100 text-blue-700",
};

const PAGE_SIZE = 100;
const EXPORT_PAGE_SIZE = 200;

async function fetchLeadsPage(partnerId, eventId, cursor) {
  const r = await base44.functions.invoke("getMyLeads", {
    partnerId, eventId, limit: EXPORT_PAGE_SIZE, cursor: cursor || undefined,
  });
  return r.data || { leads: [], next_cursor: null, has_more: false, total: 0 };
}

export default function PartnerLeadsTab({ eventId, partnerId, isReadOnly, user, myPerson }) {
  const [sending, setSending] = useState(false);
  const [leads, setLeads] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    base44.functions
      .invoke("getMyLeads", { partnerId, eventId, limit: PAGE_SIZE })
      .then((r) => {
        if (!active) return;
        const d = r.data || {};
        setLeads(d.leads || []);
        setCursor(d.next_cursor || null);
        setHasMore(!!d.has_more);
        setTotal(d.total || 0);
      })
      .catch(() => active && toast.error("Erro ao carregar leads."))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [eventId, partnerId]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const d = await fetchLeadsPage(partnerId, eventId, cursor);
      setLeads((prev) => [...prev, ...(d.leads || [])]);
      setCursor(d.next_cursor || null);
      setHasMore(!!d.has_more);
    } catch {
      toast.error("Erro ao carregar mais leads.");
    } finally {
      setLoadingMore(false);
    }
  };

  // Percorre todas as páginas restantes (cursor explícito) para export/e-mail.
  const fetchAllLeads = async () => {
    let all = [...leads];
    let cur = cursor;
    let more = hasMore;
    while (more) {
      const d = await fetchLeadsPage(partnerId, eventId, cur);
      all = all.concat(d.leads || []);
      cur = d.next_cursor || null;
      more = !!d.has_more && !!cur;
    }
    return all;
  };

  const contactEmail = myPerson?.contact_email || user?.email;

  const exportXLS = async () => {
    setSending(true);
    try {
      const all = await fetchAllLeads();
      if (!all.length) { toast.warning("Nenhum lead para exportar."); return; }
      const headers = ["Nome", "E-mail", "Origem", "Qualidade", "Notas", "Data"];
      const rows = all.map((l) => [
        l.participant_name || "",
        l.participant_email || "",
        SOURCE_LABELS[l.source] || l.source || "",
        l.quality || "",
        l.notes || "",
        l.created_date ? format(new Date(l.created_date), "dd/MM/yyyy HH:mm", { locale: ptBR }) : "",
      ]);
      const html = `<table border="1"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${String(c).replace(/</g, "&lt;")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      const blob = new Blob([`\uFEFF${html}`], { type: "application/vnd.ms-excel" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `leads-${eventId}.xls`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("XLS exportado.");
    } catch {
      toast.error("Erro ao exportar leads.");
    } finally {
      setSending(false);
    }
  };

  const sendByEmail = async () => {
    if (!myPerson?.contact_email) {
      toast.error("Você não tem e-mail de contato cadastrado. Atualize seu perfil em /profile.");
      return;
    }
    setSending(true);
    try {
      const all = await fetchAllLeads();
      if (!all.length) { toast.warning("Nenhum lead para enviar."); return; }
      const rows = all.map((l, i) => `<tr><td>${i + 1}</td><td>${l.participant_name || ""}</td><td>${l.participant_email || ""}</td><td>${SOURCE_LABELS[l.source] || l.source || ""}</td><td>${l.quality || ""}</td></tr>`).join("");
      const body = `<h2>Leads do seu parceiro</h2><p>Total: <strong>${all.length}</strong> lead(s).</p><table border="1" cellpadding="6" style="border-collapse:collapse"><thead><tr><th>#</th><th>Nome</th><th>E-mail</th><th>Origem</th><th>Qualidade</th></tr></thead><tbody>${rows}</tbody></table>`;
      await sendEmail({
        to: myPerson.contact_email,
        subject: `Leads do evento (${all.length} leads)`,
        body,
      });
      toast.success(`Leads enviados para ${myPerson.contact_email}.`);
    } catch (e) {
      toast.error("Erro ao enviar e-mail: " + e.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-display font-semibold flex items-center gap-2">
            <Users className="w-4 h-4 text-orange-600" /> Leads do Parceiro
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">{total} lead(s) neste evento</p>
        </div>
        {!isReadOnly && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={exportXLS} disabled={sending} className="gap-1.5">
              <Download className="w-3.5 h-3.5" /> Exportar XLS
            </Button>
            <Button variant="outline" size="sm" onClick={sendByEmail} disabled={sending} className="gap-1.5">
              <Mail className="w-3.5 h-3.5" /> {sending ? "Enviando..." : "Enviar por E-mail"}
            </Button>
          </div>
        )}
      </div>

      {!myPerson?.contact_email && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-sm">
          <Mail className="w-4 h-4 shrink-0" />
          Sem e-mail de contato em seu perfil. Atualize em <a href="/profile" className="underline font-medium">/profile</a> para enviar leads por e-mail.
        </div>
      )}

      {isReadOnly && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-sm">
          <Lock className="w-4 h-4 shrink-0" /> Evento encerrado — visualização somente leitura.
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : leads.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Users className="w-10 h-10 mx-auto mb-3 text-muted-foreground/40" />
            <p className="text-muted-foreground">Nenhum lead registrado neste evento ainda.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {leads.map((lead) => (
            <Card key={lead.id}>
              <CardContent className="py-3 px-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{lead.participant_name || "—"}</p>
                    <p className="text-xs text-muted-foreground truncate">{lead.participant_email || "—"}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {lead.source && <Badge variant="outline" className="text-[10px] py-0">{SOURCE_LABELS[lead.source] || lead.source}</Badge>}
                    {lead.quality && <Badge className={`text-[10px] py-0 ${QUALITY_COLORS[lead.quality] || ""}`}>{lead.quality}</Badge>}
                    {lead.created_date && (
                      <span className="text-xs text-muted-foreground">{format(new Date(lead.created_date), "dd/MM HH:mm", { locale: ptBR })}</span>
                    )}
                  </div>
                </div>
                {lead.notes && <p className="text-xs text-muted-foreground mt-1.5">{lead.notes}</p>}
              </CardContent>
            </Card>
          ))}
          {hasMore && (
            <div className="flex justify-center pt-2">
              <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Carregando..." : "Carregar mais"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}