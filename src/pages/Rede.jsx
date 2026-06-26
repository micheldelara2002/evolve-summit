import TopAppBar from "@/components/layout/TopAppBar";
import EmptyState from "@/components/ui/EmptyState";
import { Users } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { t } from "@/lib/i18n";
import { GLOBAL_REDE_ENABLED } from "@/lib/redeConfig";
import RedeGlobalView from "@/components/rede/global/RedeGlobalView";

export default function Rede() {
  const navigate = useNavigate();

  if (!GLOBAL_REDE_ENABLED) {
    return (
      <>
        <TopAppBar title={t("nav.network")} onBack={() => navigate(-1)} />
        <EmptyState
          icon={Users}
          title={t("rede.comingSoon")}
          description={t("rede.description")}
        />
      </>
    );
  }

  return (
    <>
      <TopAppBar title={t("nav.network")} onBack={() => navigate(-1)} />
      <RedeGlobalView />
    </>
  );
}