import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { ArrowLeft, CheckCircle2, Loader2, AlertCircle, Ticket, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getEventTickets, createPaymentIntent, getPaymentStatus } from "@/lib/commerceApi";
import { useToast } from "@/components/ui/use-toast";

export default function Checkout({ eventId }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const [intent, setIntent] = useState(null);
  const [publishableKey, setPublishableKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [iframeBlocked, setIframeBlocked] = useState(false);

  const items = location.state?.items;
  const couponCode = location.state?.couponCode;

  useEffect(() => {
    // Block checkout inside an iframe (Stripe requires top-level window).
    if (window.self !== window.top) {
      setIframeBlocked(true);
      setLoading(false);
      return;
    }
    if (!items || items.length === 0) {
      navigate(`/event/${eventId}`, { replace: true });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ticketData = await getEventTickets(eventId);
        const pk = ticketData.publishable_key;
        if (!pk) throw new Error("Stripe não configurado.");
        const res = await createPaymentIntent(eventId, items, couponCode || undefined);
        if (cancelled) return;
        setPublishableKey(pk);
        setIntent(res);
      } catch (e) {
        if (!cancelled) setError(e.message || "Falha ao iniciar pagamento.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [eventId]);

  if (iframeBlocked) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center space-y-3">
        <AlertCircle className="w-12 h-12 text-destructive mx-auto" />
        <h2 className="text-lg font-display font-bold">Checkout indisponível</h2>
        <p className="text-sm text-muted-foreground">O pagamento só funciona no app publicado, não dentro do preview. Abra o app em uma nova aba para finalizar a compra.</p>
        <Button variant="outline" onClick={() => navigate(`/event/${eventId}`)}><ArrowLeft className="w-4 h-4 mr-2" /> Voltar</Button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center space-y-3">
        <AlertCircle className="w-12 h-12 text-destructive mx-auto" />
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" onClick={() => navigate(`/event/${eventId}`)}><ArrowLeft className="w-4 h-4 mr-2" /> Voltar</Button>
      </div>
    );
  }

  const stripe = publishableKey ? loadStripe(publishableKey) : null;
  const options = { clientSecret: intent.client_secret, appearance: { theme: "night", variables: { colorPrimary: "#22d3ee" } } };

  return (
    <div className="max-w-lg mx-auto px-4 py-6">
      <div className="flex items-center gap-2 mb-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/event/${eventId}`)}><ArrowLeft className="w-5 h-5" /></Button>
        <h1 className="text-lg font-display font-bold">Pagamento</h1>
      </div>
      <div className="p-3 rounded-xl bg-card border border-border mb-4">
        <div className="flex justify-between text-sm"><span className="text-muted-foreground">Ingressos</span><span>{items.length}</span></div>
        <div className="flex justify-between text-sm mt-1"><span className="text-muted-foreground">Total</span><span className="font-bold text-primary text-lg">R$ {Number(intent.total).toFixed(2)}</span></div>
        {intent.discount > 0 && <div className="flex justify-between text-xs text-emerald-500 mt-1"><span>Desconto</span><span>- R$ {Number(intent.discount).toFixed(2)}</span></div>}
      </div>
      <Elements stripe={stripe} options={options}>
        <CheckoutForm paymentId={intent.payment_id} eventId={eventId} total={intent.total} />
      </Elements>
    </div>
  );
}

function CheckoutForm({ paymentId, eventId, total }) {
  const stripe = useStripe();
  const elements = useElements();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState("form"); // form | waiting | succeeded | failed
  const pollRef = useRef(null);

  const pollStatus = async () => {
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts++;
      try {
        const res = await getPaymentStatus(paymentId);
        if (res.status === "succeeded") {
          clearInterval(pollRef.current);
          setStatus("succeeded");
        } else if (res.status === "failed" || res.status === "expired") {
          clearInterval(pollRef.current);
          setStatus("failed");
        }
      } catch {}
      if (attempts > 120) clearInterval(pollRef.current); // ~6 min
    }, 3000);
  };

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const pay = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true);
    const { error: err } = await stripe.confirmPayment({ elements, redirect: "if_required" });
    if (err) {
      setProcessing(false);
      if (err.type !== "validation_error") {
        toast({ title: "Pagamento falhou", description: err.message, variant: "destructive" });
        setStatus("failed");
      }
      return;
    }
    // Payment confirmed (card) or awaiting Pix payment — poll for fulfillment.
    setStatus("waiting");
    pollStatus();
  };

  if (status === "succeeded") {
    return <SuccessScreen eventId={eventId} />;
  }

  if (status === "waiting") {
    return (
      <div className="text-center py-16 space-y-3">
        <Loader2 className="w-12 h-12 animate-spin text-primary mx-auto" />
        <h2 className="text-lg font-display font-bold">Aguardando pagamento…</h2>
        <p className="text-sm text-muted-foreground">Se pagou por Pix, aguarde a confirmação. Não feche esta tela.</p>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="text-center py-16 space-y-3">
        <AlertCircle className="w-12 h-12 text-destructive mx-auto" />
        <h2 className="text-lg font-display font-bold">Pagamento não concluído</h2>
        <p className="text-sm text-muted-foreground">Tente novamente ou escolha outro método de pagamento.</p>
        <Button variant="outline" onClick={() => setStatus("form")}>Tentar novamente</Button>
      </div>
    );
  }

  return (
    <form onSubmit={pay} className="space-y-4">
      <div className="p-4 rounded-xl bg-card border border-border">
        <PaymentElement options={{ layout: "tabs" }} />
      </div>
      <Button type="submit" disabled={!stripe || processing} className="w-full">
        {processing ? <><Loader2 className="w-4 h-4 animate-spin" /> Processando…</> : `Pagar R$ ${Number(total).toFixed(2)}`}
      </Button>
    </form>
  );
}

function SuccessScreen({ eventId }) {
  const navigate = useNavigate();
  return (
    <div className="max-w-md mx-auto px-4 py-12 text-center space-y-5">
      <CheckCircle2 className="w-16 h-16 text-emerald-500 mx-auto" />
      <div>
        <h2 className="text-xl font-display font-bold">Pagamento confirmado!</h2>
        <p className="text-sm text-muted-foreground mt-1">Seus ingressos foram emitidos e você foi inscrito no evento.</p>
      </div>
      <div className="flex flex-col gap-2">
        <Button onClick={() => navigate("/my-tickets")} className="w-full">
          <Ticket className="w-4 h-4 mr-2" /> Meus ingressos
        </Button>
        <Button variant="outline" onClick={() => navigate(`/event/${eventId}`)} className="w-full">
          Entrar no evento <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </div>
    </div>
  );
}