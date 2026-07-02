/**
 * Wrapper da aba de Certificados no EventDetail.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import CertificateIssuer from "@/components/certificados/CertificateIssuer";
import TemplateManager from "@/components/certificados/TemplateManager";

export default function CertificadosTab({ eventId, user }) {
  const { data: event } = useQuery({
    queryKey: ["event", eventId],
    queryFn: async () => {
      const list = await base44.entities.Event.filter({ id: eventId });
      return list[0];
    },
  });

  if (!event) return null;

  return (
    <div className="space-y-6">
      <TemplateManager eventId={eventId} event={event} />
      <CertificateIssuer eventId={eventId} event={event} user={user} />
    </div>
  );
}