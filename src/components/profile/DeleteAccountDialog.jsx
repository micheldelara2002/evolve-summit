import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Trash2, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

export default function DeleteAccountDialog({ open, onOpenChange }) {
  const { logout } = useAuth();
  const [confirmed, setConfirmed] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [done, setDone] = useState(false);

  const reset = () => {
    setConfirmed(false);
    setProcessing(false);
    setDone(false);
  };

  const handleOpenChange = (v) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const handleDelete = async () => {
    setProcessing(true);
    try {
      const res = await base44.functions.invoke("deleteMyAccount", {});
      if (res?.data?.ok) {
        setDone(true);
      } else {
        throw new Error(res?.data?.error || "Falha na exclusão da conta.");
      }
    } catch (err) {
      toast.error("Erro ao excluir conta: " + (err.message || "tente novamente."));
      setProcessing(false);
    }
  };

  const handleFinish = () => {
    // Invalida a sessão e redireciona para o login.
    handleOpenChange(false);
    logout(true);
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        {done ? (
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <div className="w-14 h-14 rounded-full bg-success/15 flex items-center justify-center">
              <CheckCircle2 className="w-7 h-7 text-success" />
            </div>
            <AlertDialogHeader>
              <AlertDialogTitle>Conta excluída</AlertDialogTitle>
              <AlertDialogDescription>
                Seus dados pessoais foram removidos e seu acesso ao Evolve Summit foi
                encerrado. Alguns registros históricos foram preservados de forma
                anônima para manter a integridade dos eventos.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Button onClick={handleFinish} className="w-full mt-2">
              Concluir
            </Button>
          </div>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2 text-destructive">
                <Trash2 className="w-5 h-5" /> Excluir minha conta
              </AlertDialogTitle>
              <AlertDialogDescription className="space-y-3 text-left">
                <span className="flex items-start gap-2 rounded-md bg-destructive/10 p-2.5 text-destructive">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>Esta ação é <strong>irreversível</strong>.</span>
                </span>
                <span>
                  Sua conta de acesso será encerrada e os seguintes dados pessoais
                  serão <strong>removidos</strong>:
                </span>
                <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
                  <li>Nome, e-mail, CPF, telefone e foto</li>
                  <li>Empresa, cargo, bio e links sociais</li>
                  <li>Histórico de conversas (nome do remetente)</li>
                  <li>Notificações (nome/e-mail do destinatário)</li>
                </ul>
                <span>
                  Alguns registros históricos (pontos, resgates, avaliações de
                  sessões, perguntas, certificados e métricas de eventos) serão
                  <strong> preservados de forma anônima</strong> para manter a
                  integridade dos eventos.
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>

            <label className="flex items-start gap-3 mt-4 cursor-pointer select-none">
              <Checkbox
                checked={confirmed}
                onCheckedChange={(v) => setConfirmed(!!v)}
                className="mt-0.5"
              />
              <span className="text-sm text-muted-foreground">
                Confirmo que desejo excluir minha conta permanentemente e entendo
                que esta ação não pode ser desfeita.
              </span>
            </label>

            <AlertDialogFooter className="mt-4">
              <AlertDialogCancel disabled={processing}>Cancelar</AlertDialogCancel>
              <Button
                onClick={handleDelete}
                disabled={!confirmed || processing}
                variant="destructive"
              >
                {processing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Excluindo...
                  </>
                ) : (
                  "Excluir conta"
                )}
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}