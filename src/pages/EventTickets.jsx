import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import TicketStore from "@/components/participante/TicketStore";

// Public ticket purchase page for an event — accessible to any logged-in user
// (not gated by participant association, since buying a ticket IS how you register).
export default function EventTickets() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-center gap-2 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/event/${eventId}`)}><ArrowLeft className="w-5 h-5" /></Button>
        <h1 className="text-xl font-display font-bold">Comprar Ingressos</h1>
      </div>
      <TicketStore eventId={eventId} />
    </div>
  );
}