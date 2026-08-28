import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

// Lightweight dialog wrapper for commerce forms that need custom controls
// (switches, datetime-local, native selects) not covered by the field-schema EntityFormDialog.
export default function CommerceFormDialog({ open, onClose, title, onSave, saving, children }) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">{children}</div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button type="button" onClick={onSave} disabled={saving}>
            {saving ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}