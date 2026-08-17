import { useNavigate } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Contextual top app bar for page-level headers.
 * Props:
 *  - title: string (required)
 *  - subtitle: string
 *  - onBack: function (shows back button if provided)
 *  - actions: ReactNode (right-aligned action buttons)
 *  - search: ReactNode (search input element, rendered below title row)
 */
export default function TopAppBar({ title, subtitle, onBack, actions, search }) {
  const navigate = useNavigate();

  return (
    <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-30 bg-background/80 backdrop-blur-xl border-b border-border">
      <div className="flex items-center gap-3 px-4 py-3">
        {onBack && (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 -ml-2 h-11 w-11 sm:h-9 sm:w-9"
            onClick={() => (typeof onBack === "function" ? onBack() : navigate(-1))}
            aria-label="Voltar"
          >
            <ChevronLeft className="w-5 h-5" />
          </Button>
        )}
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-display font-bold leading-tight truncate">{title}</h1>
          {subtitle && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      {search && <div className="px-4 pb-3">{search}</div>}
    </div>
  );
}