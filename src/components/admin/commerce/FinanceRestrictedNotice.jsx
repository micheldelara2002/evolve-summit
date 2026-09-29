import { Wallet } from "lucide-react";

/**
 * Aviso de módulo financeiro restrito (2026-09-29): comércio, pedidos,
 * transações e estornos são exclusivos do gerente do evento (+admin).
 */
export default function FinanceRestrictedNotice() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <div className="w-12 h-12 rounded-2xl bg-card border border-border flex items-center justify-center">
        <Wallet className="w-5 h-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">Módulo financeiro restrito</p>
      <p className="text-xs text-muted-foreground max-w-sm">
        Ingressos, cupons, pedidos, transações e estornos são gerenciados
        exclusivamente pelo gerente do evento. Fale com ele para ajustes financeiros.
      </p>
    </div>
  );
}