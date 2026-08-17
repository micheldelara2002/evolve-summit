import { useIsMobile } from "@/hooks/use-mobile";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { Loader2, ChevronDown } from "lucide-react";

/**
 * Wrapper de pull-to-refresh para telas de listagem/conteúdo dinâmico mobile.
 * No desktop (ou quando `disabled`) fica inerte e não altera o layout.
 *
 * Props:
 * - onRefresh: async callback executado ao soltar o gesto acima do threshold
 * - threshold: distância (px) para disparar (default 60)
 * - disabled: desativa o gesto (ex.: abas com gesto conflitante)
 */
export default function PullToRefresh({ onRefresh, threshold = 60, disabled = false, children, className = "" }) {
  const isMobile = useIsMobile();
  const { containerRef, pull, refreshing, pulling } = usePullToRefresh(onRefresh, {
    threshold,
    disabled: disabled || !isMobile,
  });
  const ready = pull >= threshold;

  return (
    <div ref={containerRef} className={className} data-ptr-root>
      <div
        className={`flex items-center justify-center overflow-hidden ${
          pulling || refreshing ? "" : "transition-[height] duration-200 ease-out"
        }`}
        style={{ height: pull }}
        aria-hidden="true"
      >
        {refreshing ? (
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        ) : pull > 0 ? (
          <ChevronDown
            className={`w-5 h-5 transition-transform duration-150 ${
              ready ? "rotate-180 text-primary" : "text-muted-foreground"
            }`}
          />
        ) : null}
      </div>
      {children}
    </div>
  );
}