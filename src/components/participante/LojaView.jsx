/**
 * Loja do participante com resgate real.
 * Dois saldos: pontos_totais (imutável no resgate) e pontos_disponiveis (debita no resgate).
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { ShoppingBag, ImageIcon, Star, Wallet, AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";

// ── Item card ────────────────────────────────────────────────────────────────
function ItemCard({ item, pontosDisponiveis, isReadOnly, onRedeem }) {
  const estoqueTotal = item.estoque_total ?? item.quantidade_total ?? 0;
  const estoqueDisp = Math.max(0, estoqueTotal - (item.quantidade_resgatada ?? 0));
  const esgotado = estoqueDisp === 0;
  const semSaldo = pontosDisponiveis < item.pontos_necessarios;
  const bloqueado = esgotado || isReadOnly;

  return (
    <div className={`rounded-2xl border border-border bg-card overflow-hidden flex flex-col transition-all hover:shadow-md ${(esgotado || (semSaldo && !isReadOnly)) ? "opacity-70" : ""}`}>
      {/* Image */}
      <div className="h-36 bg-muted flex items-center justify-center overflow-hidden">
        {item.imagem_url ? (
          <img src={item.imagem_url} alt={item.descricao_item} className="w-full h-full object-cover" />
        ) : (
          <ImageIcon className="w-10 h-10 text-muted-foreground/40" />
        )}
      </div>

      {/* Info */}
      <div className="p-3 flex flex-col flex-1 gap-2">
        <p className="font-medium text-sm leading-snug">{item.descricao_item}</p>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 text-primary font-semibold text-sm">
            <Star className="w-3.5 h-3.5" />
            {item.pontos_necessarios} pts
          </div>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            esgotado ? "bg-destructive/10 text-destructive" : "bg-emerald-100 text-emerald-700"
          }`}>
            {esgotado ? "Esgotado" : `${estoqueDisp} disp.`}
          </span>
        </div>

        {!isReadOnly && (
          <Button
            size="sm"
            className="w-full mt-auto"
            disabled={bloqueado || semSaldo}
            variant={semSaldo && !esgotado ? "outline" : "default"}
            onClick={() => !bloqueado && !semSaldo && onRedeem(item)}
          >
            {esgotado ? "Esgotado" : semSaldo ? "Saldo insuficiente" : "Resgatar"}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Confirm dialog ───────────────────────────────────────────────────────────
function RedeemDialog({ item, pontosDisponiveis, onConfirm, onClose, isPending }) {
  if (!item) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">Confirmar resgate</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 p-3">
            {item.imagem_url ? (
              <img src={item.imagem_url} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" />
            ) : (
              <div className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center shrink-0">
                <ShoppingBag className="w-5 h-5 text-muted-foreground" />
              </div>
            )}
            <div>
              <p className="font-medium text-sm">{item.descricao_item}</p>
              <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                <Star className="w-3 h-3 text-primary" /> {item.pontos_necessarios} pontos
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-border p-3 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Saldo disponível</span>
              <span className="font-semibold">{pontosDisponiveis} pts</span>
            </div>
            <div className="flex justify-between text-destructive">
              <span>Custo</span>
              <span>- {item.pontos_necessarios} pts</span>
            </div>
            <div className="border-t border-border pt-1.5 flex justify-between font-semibold">
              <span>Saldo após resgate</span>
              <span>{pontosDisponiveis - item.pontos_necessarios} pts</span>
            </div>
          </div>

          <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 rounded-xl p-3">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>Seus pontos totais não serão alterados. Apenas o saldo para resgate será debitado.</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={onConfirm} disabled={isPending}>
            {isPending ? "Processando..." : "Confirmar Resgate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function LojaView({ eventId, participantId, personId, isReadOnly }) {
  const queryClient = useQueryClient();
  const [redeemItem, setRedeemItem] = useState(null);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["store-items", eventId],
    queryFn: () => base44.entities.StoreItem.filter({ event_id: eventId, is_deleted: false, status: "ativo" }),
  });

  // Buscar resgates já feitos por este participante
  const { data: redemptions = [] } = useQuery({
    queryKey: ["store-redemptions", eventId, participantId],
    queryFn: () =>
      base44.entities.StoreRedemption.filter({ event_id: eventId, participant_id: participantId, is_deleted: false }),
    enabled: !!participantId,
  });

  // Calcular pontos disponíveis (pontos totais - total resgatado)
  const { data: participantData = [] } = useQuery({
    queryKey: ["participant_points", eventId, participantId],
    queryFn: () => base44.entities.Participant.filter({ event_id: eventId, is_deleted: false }),
    enabled: !!participantId,
  });

  const myParticipant = participantData.find((p) => p.id === participantId);
  const pontostotais = myParticipant?.points_total ?? myParticipant?.points ?? 0;
  const totalResgatado = redemptions.reduce((acc, r) => acc + (r.pontos_debitados || 0), 0);
  const pontosDisponiveis = Math.max(0, pontostotais - totalResgatado);

  const redeemMut = useMutation({
    mutationFn: async (item) => {
      // Validações
      if (pontosDisponiveis < item.pontos_necessarios) {
        throw new Error("Saldo insuficiente para resgate.");
      }
      const estoqueTotal = item.estoque_total ?? item.quantidade_total ?? 0;
      const estoqueDisp = Math.max(0, estoqueTotal - (item.quantidade_resgatada ?? 0));
      if (estoqueDisp === 0) {
        throw new Error("Item sem estoque disponível.");
      }

      // Verificar limite por usuário
      if (item.limite_por_usuario) {
        const myRedemptionsForItem = redemptions.filter(
          (r) => r.store_item_id === item.id && r.status !== "cancelado"
        );
        if (myRedemptionsForItem.length >= item.limite_por_usuario) {
          throw new Error(`Limite de ${item.limite_por_usuario} resgate(s) por participante atingido.`);
        }
      }

      // Registrar resgate
      await base44.entities.StoreRedemption.create({
        event_id: eventId,
        participant_id: participantId,
        person_id: personId || undefined,
        store_item_id: item.id,
        item_description: item.descricao_item,
        pontos_debitados: item.pontos_necessarios,
        status: "pendente",
      });

      // Decrementar estoque
      await base44.entities.StoreItem.update(item.id, {
        quantidade_resgatada: (item.quantidade_resgatada ?? 0) + 1,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["store-items", eventId] });
      queryClient.invalidateQueries({ queryKey: ["store-redemptions", eventId, participantId] });
      setRedeemItem(null);
      toast.success("Resgate realizado com sucesso!", {
        description: "Apresente este resgate na equipe do evento.",
        icon: <CheckCircle2 className="w-4 h-4 text-emerald-500" />,
      });
    },
    onError: (err) => {
      toast.error(err.message || "Erro ao realizar resgate.");
      setRedeemItem(null);
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header com saldos */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-lg font-display font-semibold">Loja</h2>
        <div className="flex items-center gap-3">
          {isReadOnly ? (
            <span className="text-xs text-muted-foreground bg-muted rounded-full px-3 py-1">Modo consulta</span>
          ) : (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-medium">
              <Wallet className="w-4 h-4" />
              <span>{pontosDisponiveis} pts para resgate</span>
            </div>
          )}
        </div>
      </div>

      {/* Meus resgates (histórico rápido) */}
      {!isReadOnly && redemptions.length > 0 && (
        <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Meus Resgates</p>
          {redemptions.map((r) => (
            <div key={r.id} className="flex items-center justify-between text-sm py-0.5">
              <span className="truncate">{r.item_description}</span>
              <span className="text-muted-foreground shrink-0 ml-2">- {r.pontos_debitados} pts</span>
            </div>
          ))}
        </div>
      )}

      {items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <ShoppingBag className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>Nenhum item disponível na loja.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {items.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              pontosDisponiveis={pontosDisponiveis}
              isReadOnly={isReadOnly}
              onRedeem={setRedeemItem}
            />
          ))}
        </div>
      )}

      <RedeemDialog
        item={redeemItem}
        pontosDisponiveis={pontosDisponiveis}
        onConfirm={() => redeemMut.mutate(redeemItem)}
        onClose={() => setRedeemItem(null)}
        isPending={redeemMut.isPending}
      />
    </div>
  );
}