/**
 * Dialog exibido quando CPF já existe na base global ao cadastrar participante.
 * Oferece: [Vincular ao evento] [Cancelar]
 */
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { UserCheck } from "lucide-react";

export default function CpfReuseDialog({ open, existingPerson, onLink, onCancel }) {
  if (!existingPerson) return null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            <UserCheck className="w-5 h-5 text-primary" />
            Participante já existe
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">
            Este CPF já está cadastrado na base:
          </p>
          <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm">
            <p className="font-medium">{existingPerson.full_name}</p>
            <p className="text-xs text-muted-foreground">{existingPerson.email}</p>
            {existingPerson.cpf && <p className="text-xs text-muted-foreground font-mono">CPF: {existingPerson.cpf}</p>}
          </div>
          <p className="text-sm">Deseja vinculá-lo a este evento?</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancelar</Button>
          <Button onClick={() => onLink(existingPerson)}>Vincular ao evento</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}