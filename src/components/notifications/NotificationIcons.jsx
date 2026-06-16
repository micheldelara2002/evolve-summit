/**
 * Ícones e indicadores visuais reutilizáveis para tipo e prioridade de notificações.
 */
import { Info, Clock, Megaphone, ArrowDown, Minus, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export const TYPE_CONFIG = {
  informativa: {
    icon: Info,
    label: "Informativa",
    iconClass: "text-blue-500",
  },
  lembrete: {
    icon: Clock,
    label: "Lembrete",
    iconClass: "text-orange-500",
  },
  destaque: {
    icon: Megaphone,
    label: "Destaque",
    iconClass: "text-purple-600",
  },
};

export const PRIORITY_CONFIG = {
  low: {
    icon: ArrowDown,
    label: "Baixa",
    iconClass: "text-muted-foreground",
    badgeClass: "bg-muted text-muted-foreground",
  },
  normal: {
    icon: Minus,
    label: "Normal",
    iconClass: "text-muted-foreground",
    badgeClass: "bg-muted text-muted-foreground",
  },
  high: {
    icon: AlertTriangle,
    label: "Alta",
    iconClass: "text-red-500",
    badgeClass: "bg-red-100 text-red-700",
  },
};

export function TypeIcon({ type, className = "" }) {
  const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.informativa;
  const Icon = cfg.icon;
  return <Icon className={`w-4 h-4 ${cfg.iconClass} ${className}`} />;
}

export function PriorityBadge({ priority }) {
  if (!priority || priority === "normal") return null;
  const cfg = PRIORITY_CONFIG[priority];
  if (!cfg) return null;
  const Icon = cfg.icon;
  return (
    <Badge className={`${cfg.badgeClass} gap-1 text-xs px-1.5 py-0`}>
      <Icon className="w-3 h-3" />
      {cfg.label}
    </Badge>
  );
}

/**
 * Retorna classes extras para o card dependendo do tipo/prioridade.
 */
export function getCardHighlightClasses(type, priority) {
  let classes = "";
  if (type === "destaque") classes += " border-purple-300 ring-1 ring-purple-200";
  if (priority === "high") classes += " border-red-300";
  return classes;
}