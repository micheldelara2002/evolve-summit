import { cn } from "@/lib/utils";

/**
 * Reusable empty state — icon, title, description, optional action.
 */
export default function EmptyState({ icon: Icon, title, description, action, className }) {
  return (
    <div className={cn("text-center py-16 space-y-3 max-w-sm mx-auto", className)}>
      {Icon && (
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto">
          <Icon className="w-8 h-8 text-muted-foreground" />
        </div>
      )}
      <h2 className="text-lg font-display font-semibold">{title}</h2>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}