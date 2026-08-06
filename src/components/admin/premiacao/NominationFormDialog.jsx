import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

export default function NominationFormDialog({ open, onClose, onSaved, eventId, categories, nomination }) {
  const [categoryId, setCategoryId] = useState("");
  const [nomineeType, setNomineeType] = useState("session");
  const [nomineeId, setNomineeId] = useState("");
  const [nomineeName, setNomineeName] = useState("");
  const [nomineeSubtitle, setNomineeSubtitle] = useState("");
  const [saving, setSaving] = useState(false);

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", eventId],
    queryFn: () => base44.entities.Session.filter({ event_id: eventId, is_deleted: false }),
    enabled: !!eventId,
  });

  useEffect(() => {
    if (open) {
      setCategoryId(nomination?.category_id || categories[0]?.id || "");
      setNomineeType(nomination?.nominee_type || "session");
      setNomineeId(nomination?.nominee_id || "");
      setNomineeName(nomination?.nominee_name || "");
      setNomineeSubtitle(nomination?.nominee_subtitle || "");
    }
  }, [open, nomination, categories]);

  const pickSession = (id) => {
    const s = sessions.find((x) => x.id === id);
    setNomineeId(id);
    setNomineeName(s?.speaker_name || s?.title || "");
    setNomineeSubtitle(s?.title || "");
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = { event_id: eventId, category_id: categoryId, nominee_type: nomineeType, nominee_id: nomineeId, nominee_name: nomineeName, nominee_subtitle: nomineeSubtitle, status: nomination?.status || "nominated" };
      if (nomination?.id) await base44.entities.AwardNomination.update(nomination.id, payload);
      else await base44.entities.AwardNomination.create(payload);
      onSaved?.();
      onClose?.();
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{nomination ? "Editar indicação" : "Nova indicação"}</DialogTitle>
          <DialogDescription>Indique um candidato à categoria.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Categoria</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
              <SelectContent>{categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Tipo do indicado</Label>
            <Select value={nomineeType} onValueChange={setNomineeType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="session">Sessão</SelectItem>
                <SelectItem value="participant">Participante</SelectItem>
                <SelectItem value="person">Pessoa</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {nomineeType === "session" && (
            <div className="space-y-1">
              <Label>Sessão</Label>
              <Select value={nomineeId} onValueChange={pickSession}>
                <SelectTrigger><SelectValue placeholder="Selecione a sessão" /></SelectTrigger>
                <SelectContent>{sessions.map((s) => <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label>Nome do indicado</Label>
            <Input value={nomineeName} onChange={(e) => setNomineeName(e.target.value)} placeholder="Nome" />
          </div>
          <div className="space-y-1">
            <Label>Info extra</Label>
            <Input value={nomineeSubtitle} onChange={(e) => setNomineeSubtitle(e.target.value)} placeholder="Ex: título da palestra" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving || !categoryId || !nomineeName.trim()}>Salvar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}