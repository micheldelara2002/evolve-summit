/**
 * Wrapper da aba de Certificados no EventDetail.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import CertificateIssuer from "@/components/certificados/CertificateIssuer";

export default function CertificadosTab({ eventId, user }) {
  const { data: event } = useQuery({
    queryKey: ["event", eventId],
    queryFn: async () => {
      const list = await base44.entities.Event.filter({ id: eventId });
      return list[0];
    },
  });

  if (!event) return null;

  return <CertificateIssuer eventId={eventId} event={event} user={user} />;
}