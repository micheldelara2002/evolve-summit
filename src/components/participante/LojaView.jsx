/**
 * Visualização da loja para o participante (somente leitura).
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { ShoppingBag, ImageIcon, Star } from "lucide-react";

function ItemCard({ item }) {
  const estoqueTotal = item.estoque_total ?? item.quantidade_total ?? 0;
  const estoqueDisp = Math.max(0, estoqueTotal - (item.quantidade_resgatada ?? 0));
  const esgotado = estoqueDisp === 0;

  return (
    <div className={`rounded-2xl border border-border bg-card overflow-hidden flex flex-col transition-all hover:shadow-md ${esgotado ? "opacity-60" : ""}`}>
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
        <div className="flex items-center justify-between mt-auto">
          <div className="flex items-center gap-1 text-primary font-semibold text-sm">
            <Star className="w-3.5 h-3.5" />
            {item.pontos_necessarios} pts
          </div>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            esgotado
              ? "bg-destructive/10 text-destructive"
              : "bg-emerald-100 text-emerald-700"
          }`}>
            {esgotado ? "Esgotado" : `${estoqueDisp} disp.`}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function LojaView({ eventId, isReadOnly }) {
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["store-items", eventId],
    queryFn: () => base44.entities.StoreItem.filter({ event_id: eventId, is_deleted: false, status: "ativo" }),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <ShoppingBag className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <p>Nenhum item disponível na loja.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-display font-semibold">Loja</h2>
        {isReadOnly && (
          <span className="text-xs text-muted-foreground bg-muted rounded-full px-3 py-1">Modo consulta</span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
        {items.map((item) => (
          <ItemCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}