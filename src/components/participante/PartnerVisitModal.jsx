/**
 * Modal de confirmação de visita ao estande do parceiro.
 * Aberto quando o participante escaneia o QR Code de um parceiro.
 * Valida: parceiro existe, está associado ao evento, e visita não duplicada.
 * Ao confirmar: cria Lead (source=booth_scan) e dispara motor de pontos.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { processAction } from "@/lib/scoringEngine";
import { incLeadsCounter } from "@/lib/businessCounters";
import { Building2, Globe, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

export default function PartnerVisitModal({ partnerId, eventId, personId, participantId, person, isReadOnly, onClose }) {
  const queryClient = useQueryClient();
  const [confirmStatus, setConfirmStatus] = useState(null); // null | "success" | "error"

  // Fetch partner
  const partnerQ = useQuery({
    queryKey: ["partner", partnerId],
    queryFn: () => base44.entities.Partner.get(partnerId),
    enabled: !!partnerId,
  });

  // Validate: partner in event + existing visit
  const validationQ = useQuery({
    queryKey: ["partner_visit_check", eventId, partnerId, personId],
    queryFn: async () => {
      const [eventPartners, existingLeads] = await Promise.all([
        base44.entities.EventPartner.filter({ event_id: eventId, partner_id: partnerId, is_deleted: false }),
        personId
          ? base44.entities.Lead.filter({ event_id: eventId, partner_id: partnerId, person_id: personId, source: "booth_scan" })
          : [],
      ]);
      return {
        isInEvent: eventPartners.some((ep) => ep.is_active),
        alreadyVisited: existingLeads.length > 0,
      };
    },
    enabled: !!partnerId && !!eventId,
  });

  const partner = partnerQ.data;
  const isLoading = partnerQ.isLoading || validationQ.isLoading;
  const isError = partnerQ.isError || validationQ.isError;
  const isInEvent = validationQ.data?.isInEvent;
  const alreadyVisited = validationQ.data?.alreadyVisited;

  // Derived display states (mutually exclusive)
  const showLoading = isLoading && !confirmStatus;
  const showNoPerson = !isLoading && !isError && !personId && !confirmStatus;
  const showEventFinished = !isLoading && !isError && personId && isReadOnly && !confirmStatus;
  const showError = !isLoading && (isError || !partner || !isInEvent) && !confirmStatus;
  const showAlreadyVisited = !isLoading && !isError && personId && !isReadOnly && alreadyVisited && !confirmStatus;
  const showReady = !isLoading && !isError && partner && isInEvent && !alreadyVisited && personId && !isReadOnly && !confirmStatus;
  const showSuccess = confirmStatus === "success";
  const showConfirmError = confirmStatus === "error";

  const confirmMut = useMutation({
    mutationFn: async () => {
      const lead = await base44.entities.Lead.create({
        event_id: eventId,
        partner_id: partnerId,
        participant_id: participantId,
        person_id: personId,
        participant_name: person?.full_name || "",
        participant_email: person?.contact_email || "",
        source: "booth_scan",
        visited_at: new Date().toISOString(),
        person_phone: person?.phone || "",
        person_linkedin: person?.linkedin || "",
        person_company: person?.company || "",
        person_job_title: person?.job_title || "",
      });
      await incLeadsCounter(eventId, lead?.created_date, partnerId);
      // Trigger scoring engine (best-effort — lead is already saved)
      try {
        await processAction({ eventId, participantId, personId, acao: "visita_estande", refId: partnerId });
      } catch (e) { /* scoring failure shouldn't block the visit */ }
    },
    onSuccess: () => {
      setConfirmStatus("success");
      queryClient.invalidateQueries({ queryKey: ["my_participant_points"] });
    },
    onError: () => setConfirmStatus("error"),
  });

  return (
    <Dialog open={!!partnerId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-primary" /> Visita ao Estande
          </DialogTitle>
        </DialogHeader>

        {showLoading && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Carregando dados do parceiro...</p>
          </div>
        )}

        {showNoPerson && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <AlertCircle className="w-10 h-10 text-amber-500" />
            <p className="text-sm text-muted-foreground">
              Você precisa completar seu perfil para registrar visitas a estandes.
            </p>
            <Button variant="outline" size="sm" onClick={onClose}>Fechar</Button>
          </div>
        )}

        {showEventFinished && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <AlertCircle className="w-10 h-10 text-amber-500" />
            <p className="text-sm text-muted-foreground">
              Este evento está encerrado. Não é possível registrar novas visitas.
            </p>
            <Button variant="outline" size="sm" onClick={onClose}>Fechar</Button>
          </div>
        )}

        {showError && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <AlertCircle className="w-10 h-10 text-red-500" />
            <p className="text-sm text-muted-foreground">
              {isError ? "Não foi possível carregar os dados. Tente novamente." :
               !partner ? "Parceiro não encontrado. QR Code inválido." :
               "Este parceiro não participa do evento atual."}
            </p>
            <Button variant="outline" size="sm" onClick={onClose}>Fechar</Button>
          </div>
        )}

        {showAlreadyVisited && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            <p className="text-sm font-medium">Você já visitou este parceiro neste evento.</p>
            <Button variant="outline" size="sm" onClick={onClose}>Fechar</Button>
          </div>
        )}

        {showSuccess && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <CheckCircle2 className="w-12 h-12 text-emerald-500" />
            <p className="text-base font-display font-semibold">Visita confirmada.</p>
            <p className="text-xs text-muted-foreground">Seu lead foi registrado para o parceiro.</p>
            <Button variant="outline" size="sm" onClick={onClose}>Fechar</Button>
          </div>
        )}

        {showConfirmError && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <AlertCircle className="w-10 h-10 text-red-500" />
            <p className="text-sm text-muted-foreground">
              Não foi possível registrar a visita. Tente novamente.
            </p>
            <Button variant="outline" size="sm" onClick={onClose}>Fechar</Button>
          </div>
        )}

        {showReady && partner && (
          <div className="space-y-4">
            <div className="flex flex-col items-center gap-3 text-center">
              {partner.logo_url ? (
                <img src={partner.logo_url} alt={partner.trade_name} className="w-20 h-20 rounded-xl object-cover border border-border" />
              ) : (
                <div className="w-20 h-20 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Building2 className="w-10 h-10 text-primary" />
                </div>
              )}
              <div>
                <p className="font-display font-semibold text-lg">{partner.trade_name || partner.legal_name}</p>
                {partner.website && (
                  <a href={partner.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1">
                    <Globe className="w-3 h-3" /> {partner.website}
                  </a>
                )}
              </div>
            </div>

            <div className="flex flex-col-reverse sm:flex-row gap-2">
              <Button variant="outline" className="flex-1" onClick={onClose}>Cancelar</Button>
              <Button
                className="flex-1"
                disabled={confirmMut.isPending}
                onClick={() => confirmMut.mutate()}
              >
                {confirmMut.isPending ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Confirmando...</>
                ) : (
                  "Confirmar visita"
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}