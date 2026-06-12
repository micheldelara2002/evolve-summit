import { Badge } from "@/components/ui/badge";
import { t } from "@/lib/i18n";

const statusStyles = {
  draft: "bg-muted text-muted-foreground",
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  finished: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
  cancelled: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

export default function StatusBadge({ status }) {
  return (
    <Badge variant="secondary" className={`${statusStyles[status] || ""} text-xs font-medium`}>
      {t(`status.${status}`) || status}
    </Badge>
  );
}