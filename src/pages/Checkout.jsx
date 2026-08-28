import { useParams } from "react-router-dom";
import Checkout from "@/components/participante/Checkout";

export default function CheckoutPage() {
  const { eventId } = useParams();
  return <Checkout eventId={eventId} />;
}