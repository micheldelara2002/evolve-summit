import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Ticket, Plus, Minus, ShoppingCart, Tag, Clock, ArrowLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/use-toast";
import { getEventTickets } from "@/lib/commerceApi";

export default function TicketStore({ eventId, user }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [cart, setCart] = useState([]); // { lot, ticket_type, holder_name, holder_email }
  const [couponCode, setCouponCode] = useState("");
  const [cartOpen, setCartOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["event-tickets", eventId],
    queryFn: () => getEventTickets(eventId),
  });

  const addToCart = (lot, ttype) => {
    setCart((prev) => [
      ...prev,
      {
        lot,
        ticket_type: ttype,
        holder_name: "",
        holder_email: "",
        key: `${lot.id}-${prev.length}`,
      },
    ]);
    toast({ title: "Ingresso adicionado ao carrinho." });
  };

  const updateHolder = (key, field, value) => {
    setCart((prev) => prev.map((c) => (c.key === key ? { ...c, [field]: value } : c)));
  };

  const removeFromCart = (key) => setCart((prev) => prev.filter((c) => c.key !== key));

  const subtotal = cart.reduce((s, c) => s + c.lot.price, 0);
  const checkout = () => {
    if (cart.length === 0) return;
    for (const c of cart) {
      if (!c.holder_name.trim() || !c.holder_email.trim()) {
        toast({ title: "Preencha nome e email de cada titular.", variant: "destructive" });
        setCartOpen(true);
        return;
      }
    }
    const items = cart.map((c) => ({
      lot_id: c.lot.id,
      ticket_type_id: c.ticket_type.id,
      holder_name: c.holder_name,
      holder_email: c.holder_email,
    }));
    navigate(`/checkout/${eventId}`, { state: { items, couponCode } });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const types = data?.ticket_types || [];
  if (types.length === 0) {
    return (
      <div className="text-center py-16 space-y-3">
        <Ticket className="w-12 h-12 text-muted-foreground mx-auto" />
        <p className="text-muted-foreground">Ingressos ainda não estão à venda para este evento.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-display font-bold flex items-center gap-2"><Ticket className="w-5 h-5 text-primary" /> Ingressos</h2>
        {cart.length > 0 && (
          <Button size="sm" onClick={() => setCartOpen(true)}>
            <ShoppingCart className="w-4 h-4" /> {cart.length}
          </Button>
        )}
      </div>

      <div className="space-y-4">
        {types.map((ttype) => (
          <div key={ttype.id} className="space-y-2">
            <div className="px-1">
              <h3 className="text-sm font-semibold">{ttype.name}</h3>
              {ttype.description && <p className="text-xs text-muted-foreground">{ttype.description}</p>}
            </div>
            {ttype.lots.map((lot) => (
              <div key={lot.id} className="flex items-center gap-3 p-3.5 rounded-xl bg-card border border-border">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">{lot.name}</p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground mt-0.5">
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {lot.remaining} disponíveis</span>
                    {lot.sale_end && <span>até {new Date(lot.sale_end).toLocaleDateString("pt-BR")}</span>}
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-display font-bold text-primary text-lg">R$ {Number(lot.price).toFixed(2)}</p>
                  <Button size="sm" variant="outline" className="mt-1 touch-manipulation select-none" onClick={() => addToCart(lot, ttype)} disabled={lot.remaining <= 0}>
                    <Plus className="w-4 h-4" /> Adicionar
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Cart sheet */}
      <Sheet open={cartOpen} onOpenChange={setCartOpen}>
        <SheetContent className="flex flex-col max-h-screen">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2"><ShoppingCart className="w-5 h-5" /> Carrinho ({cart.length})</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 space-y-3 py-2">
            {cart.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-12">Carrinho vazio.</p>
            ) : (
              cart.map((c) => (
                <div key={c.key} className="p-3 rounded-xl bg-muted/40 border border-border space-y-2">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-medium">{c.ticket_type.name}</p>
                      <p className="text-xs text-muted-foreground">{c.lot.name} · R$ {Number(c.lot.price).toFixed(2)}</p>
                    </div>
                    <Button size="icon" variant="ghost" onClick={() => removeFromCart(c.key)}>
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                  <Input placeholder="Nome do titular" value={c.holder_name} onChange={(e) => updateHolder(c.key, "holder_name", e.target.value)} />
                  <Input placeholder="Email do titular" type="email" value={c.holder_email} onChange={(e) => updateHolder(c.key, "holder_email", e.target.value)} />
                </div>
              ))
            )}

            {cart.length > 0 && (
              <div className="flex items-center gap-2 pt-2">
                <Tag className="w-4 h-4 text-muted-foreground" />
                <Input placeholder="Cupom de desconto" value={couponCode} onChange={(e) => setCouponCode(e.target.value.toUpperCase())} className="flex-1" />
              </div>
            )}
          </div>
          {cart.length > 0 && (
            <SheetFooter className="px-4 pb-4 flex-col gap-2 items-stretch">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Subtotal</span>
                <span>R$ {subtotal.toFixed(2)}</span>
              </div>
              <Button onClick={checkout} className="w-full">
                Ir para pagamento
              </Button>
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}