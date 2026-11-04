import { Button } from "@/components/ui/button";
import { UserX } from "lucide-react";
import { base44 } from "@/api/base44Client";

/**
 * Cadastro atômico (2026-11-04) — tela de bloqueio.
 *
 * Sem Person vinculada a conta NÃO existe para o app: nenhuma área é liberada.
 * Não há recuperação separada aqui — a pessoa tenta de novo entrando novamente,
 * o que refaz o provisionamento do zero.
 */
export default function AccountNotProvisionedScreen({ message }) {
  const handleLeave = async () => {
    await base44.auth.logout();
    window.location.href = "/login";
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background p-6">
      <div className="max-w-sm w-full text-center space-y-5">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto">
          <UserX className="w-8 h-8 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-display font-bold">Cadastro não concluído</h1>
          <p className="text-sm text-muted-foreground">
            {message || "Seu cadastro não foi concluído. Tente novamente."} Seu acesso só é
            liberado quando o cadastro é concluído por inteiro.
          </p>
          <p className="text-sm text-muted-foreground">
            Saia e entre novamente para tentar de novo.
          </p>
        </div>
        <Button variant="outline" className="w-full" onClick={handleLeave}>
          Sair
        </Button>
      </div>
    </div>
  );
}