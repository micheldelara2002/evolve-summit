/**
 * Faixa de patrocinadores agrupados por plano, com logos proporcionais.
 * Exibida na faixa superior do detalhe do evento.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Building2 } from "lucide-react";

const PLAN_ORDER = ["diamante", "ouro", "prata", "bronze", "apoiador"];

const PLAN_CONFIG = {
  diamante: { label: "Diamante", logoH: "h-12", textSize: "text-sm" },
  ouro:     { label: "Ouro",     logoH: "h-9",  textSize: "text-xs" },
  prata:    { label: "Prata",    logoH: "h-7",  textSize: "text-xs" },
  bronze:   { label: "Bronze",   logoH: "h-6",  textSize: "text-[11px]" },
  apoiador: { label: "Apoiador", logoH: "h-5",  textSize: "text-[10px]" },
};

export default function SponsorsStrip({ eventId }) {
  const { data: eventPartners = [] } = useQuery({
    queryKey: ["event-partners-strip", eventId],
    queryFn: () => base44.entities.EventPartner.filter({ event_id: eventId, is_active: true, is_deleted: false }),
    enabled: !!eventId,
  });

  const partnerIds = [...new Set(eventPartners.map((ep) => ep.partner_id))];

  const { data: partners = [] } = useQuery({
    queryKey: ["partners-strip", partnerIds.join(",")],
    queryFn: async () => {
      if (!partnerIds.length) return [];
      const all = await base44.entities.Partner.filter({ is_active: true, is_deleted: false });
      return all.filter((p) => partnerIds.includes(p.id));
    },
    enabled: partnerIds.length > 0,
  });

  const partnerMap = Object.fromEntries(partners.map((p) => [p.id, p]));

  // Agrupar por plano
  const byPlan = {};
  eventPartners.forEach((ep) => {
    if (!byPlan[ep.sponsorship_plan]) byPlan[ep.sponsorship_plan] = [];
    byPlan[ep.sponsorship_plan].push(ep);
  });

  const activePlans = PLAN_ORDER.filter((plan) => byPlan[plan]?.length > 0);

  if (activePlans.length === 0) return null;

  return (
    <div className="border-t border-white/10 pt-3 pb-1 space-y-3">
      {activePlans.map((plan) => {
        const config = PLAN_CONFIG[plan];
        const eps = byPlan[plan];
        return (
          <div key={plan} className="space-y-1.5">
            <p className={`${config.textSize} font-medium text-white/50 uppercase tracking-wider`}>{config.label}</p>
            <div className="flex flex-wrap items-center gap-3">
              {eps.map((ep) => {
                const partner = partnerMap[ep.partner_id];
                if (!partner) return null;
                return (
                  <div key={ep.id} className="flex items-center">
                    {partner.logo_url ? (
                      <img
                        src={partner.logo_url}
                        alt={partner.trade_name}
                        className={`${config.logoH} w-auto object-contain`}
                        title={partner.trade_name}
                      />
                    ) : (
                      <div className="flex items-center gap-1 text-white/70">
                        <Building2 className="w-3.5 h-3.5 shrink-0" />
                        <span className={`${config.textSize} font-medium`}>{partner.trade_name}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}