import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Activity } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function SystemHealth() {
  const navigate = useNavigate();
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/")}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-emerald-600" />
          <h1 className="text-xl font-display font-bold">{t("home.systemHealth")}</h1>
        </div>
      </div>
      <div className="rounded-2xl border border-border bg-card p-8 text-center text-muted-foreground">
        <Activity className="w-10 h-10 mx-auto mb-3 text-emerald-400" />
        <p className="text-sm">Dashboard de Saúde do Sistema em construção.</p>
      </div>
    </div>
  );
}