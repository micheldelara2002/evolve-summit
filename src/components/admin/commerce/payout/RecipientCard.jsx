import { useState } from "react";
import { AlertTriangle, Landmark, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { linkEventPayoutAccount } from "@/lib/payoutApi";

const STATUS_LABEL = {
  pending: "verificação pendente",
  verified: "verificada",
  restricted: "ação necessária",
  rejected: "rejeitada",
};

// Vincula (ou desvincula) a conta Stripe Connect do organizador que recebe as
// vendas deste evento. Sem vínculo, as vendas caem na conta da plataforma.
export default function RecipientCard({ eventId, data, isLoading, onChanged }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const accounts = data?.accounts || [];
  const linked = data?.linked || null;

  const link = async (accountId) => {
    setBusy(true);
    try {
      await linkEventPayoutAccount(eventId, accountId || null);
      await onChanged?.();
      toast({ title: accountId ? "Conta vinculada." : "Conta desvinculada." });
    } catch (e) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
    setBusy(false);
  };

  return (
    <section className="p-4 rounded-xl bg-card border border-border space-y-3">
      <div className="flex items-center gap-2">
        <Landmark className="w-5 h-5 text-primary" />
        <h3 className="text-sm font-semibold">Conta que recebe as vendas</h3>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : accounts.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Nenhum organizador conectou uma conta ainda. O organizador conecta em <b>Meus Eventos → Receber minhas vendas</b>.
        </p>
      ) : (
        <div className="flex gap-2">
          <Select value={linked?.id || ""} onValueChange={(v) => link(v)} disabled={busy}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Selecionar conta recebedora" />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.legal_name || "Conta"} · {STATUS_LABEL[a.status] || a.status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {linked && (
            <Button size="sm" variant="outline" onClick={() => link(null)} disabled={busy}>
              <Unlink className="w-3.5 h-3.5" /> Desvincular
            </Button>
          )}
        </div>
      )}

      {!linked && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-xs">
            Sem conta vinculada: as vendas deste evento caem na <b>conta da plataforma</b> (admin). Vincule a conta conectada do organizador para ele receber direto.
          </p>
        </div>
      )}
      {linked && !linked.charges_enabled && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
          <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <p className="text-xs">
            A conta vinculada ainda não concluiu a verificação — <b>as vendas ficam bloqueadas</b> até o organizador concluir o cadastro no Stripe.
          </p>
        </div>
      )}
      {linked?.charges_enabled && (
        <p className="text-[11px] text-muted-foreground">
          Vendas caem direto no saldo Stripe do organizador; a comissão é retida automaticamente e o Stripe cuida de repasses, taxas e estornos.
        </p>
      )}
    </section>
  );
}