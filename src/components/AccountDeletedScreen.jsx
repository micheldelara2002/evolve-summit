import { Button } from "@/components/ui/button";
import { ShieldOff } from "lucide-react";
import { base44 } from "@/api/base44Client";

export default function AccountDeletedScreen() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background p-6">
      <div className="max-w-sm w-full text-center space-y-5">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto">
          <ShieldOff className="w-8 h-8 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-display font-bold">Conta excluída</h1>
          <p className="text-sm text-muted-foreground">
            Esta conta foi excluída e não está mais disponível. Seus dados pessoais
            foram removidos. Alguns registros históricos foram preservados de forma
            anônima para manter a integridade dos eventos.
          </p>
        </div>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => base44.auth.redirectToLogin(window.location.href)}
        >
          Ir para o login
        </Button>
      </div>
    </div>
  );
}