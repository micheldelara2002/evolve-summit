/**
 * Adicionar pessoa ao evento.
 * Passo 1: busca Person global (nome/e-mail; documento se houver ≥3 dígitos).
 * Passo 2a: associa a Person encontrada (upsert Participant).
 * Passo 2b: cria nova Person (via PersonFormDialog) e associa automaticamente.
 */
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import PersonFormDialog from "@/components/admin/PersonFormDialog";
import { searchPersons } from "@/lib/personApi";
import { createParticipant, findPersonIdsByDocument } from "@/lib/participantApi";
import { incParticipantCounter } from "@/lib/businessCounters";
import { logAudit } from "@/lib/audit";

export default function AddPersonToEventDialog({ eventId, existingParticipants, user, onClose, onSuccess }) {
  const [step, setStep] = useState("search"); // "search" | "create"
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState(null); // null = not searched yet
  const [searching, setSearching] = useState(false);
  const [associating, setAssociating] = useState(false);

  const alreadyInEvent = new Set(
    existingParticipants.filter((p) => p.person_id).map((p) => p.person_id)
  );
  const alreadyByEmail = new Set(
    existingParticipants.map((p) => p.email).filter(Boolean)
  );

  const handleSearch = async () => {
    if (!searchQ.trim()) return;
    setSearching(true);
    const q = searchQ.trim().toLowerCase();
    // Search Person global — via backend (admin OU gestor do evento) — Lote 4
    const all = await searchPersons(eventId, q);
    const results = all;
    // Document search: only if query has digits, scoped to persons already loaded
    let extra = [];
    const digits = q.replace(/\D/g, "");
    if (digits.length >= 3) {
      const { person_ids } = await findPersonIdsByDocument(eventId, digits);
      const docPersonIds = new Set(person_ids || []);
      extra = all.filter((p) => docPersonIds.has(p.id) && !results.find((r) => r.id === p.id));
    }
    setSearchResults([...results, ...extra]);
    setSearching(false);
  };

  const associatePerson = async (person) => {
    // Check if already in event
    if (alreadyInEvent.has(person.id)) {
      toast.error("Esta pessoa já está associada a este evento.");
      return;
    }
    if (alreadyByEmail.has(person.contact_email) && person.contact_email) {
      toast.error("Já existe um participante com este e-mail neste evento.");
      return;
    }
    setAssociating(true);
    const created = await createParticipant(eventId, {
      event_id: eventId,
      full_name: person.full_name,
      email: person.contact_email || "",
      phone: person.phone || "",
      company: person.company || "",
      job_title: person.job_title || "",
      bio: person.bio || "",
      linkedin: person.linkedin || "",
      person_id: person.id,
      role_in_event: "attendee",
      registration_status: "registered",
      created_day: new Date().toISOString().slice(0, 10),
      is_deleted: false,
    });
    await incParticipantCounter(eventId, created?.created_date, "attendee");
    logAudit({ event_id: eventId, action: "create", entity_type: "Participant", entity_id: person.id, user,
      details: { field: "vínculo_evento", new_value: "associado" } });
    setAssociating(false);
    onSuccess();
    onClose();
    toast.success("Pessoa associada ao evento.");
  };

  const handlePersonCreated = async (newPerson) => {
    // After creating Person, associate immediately
    await associatePerson(newPerson);
  };

  if (step === "create") {
    return (
      <PersonFormDialog
        person={null}
        eventId={eventId}
        onClose={() => setStep("search")}
        onSaved={handlePersonCreated}
      />
    );
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Adicionar pessoa ao evento</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <p className="text-xs text-muted-foreground">
            Busque uma pessoa já cadastrada no sistema ou crie uma nova.
          </p>

          {/* Search box */}
          <div className="flex gap-2">
            <Input
              placeholder="Nome, e-mail ou documento..."
              value={searchQ}
              onChange={(e) => { setSearchQ(e.target.value); setSearchResults(null); }}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="flex-1"
            />
            <Button type="button" variant="outline" onClick={handleSearch} disabled={searching || !searchQ.trim()}>
              {searching ? "..." : <Search className="w-4 h-4" />}
            </Button>
          </div>

          {/* Results */}
          {searchResults !== null && (
            <div className="space-y-1 max-h-56 overflow-y-auto">
              {searchResults.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-3">
                  Nenhuma pessoa encontrada.
                </p>
              ) : (
                searchResults.map((p) => {
                  const inEvent = alreadyInEvent.has(p.id) || (p.contact_email && alreadyByEmail.has(p.contact_email));
                  return (
                    <div
                      key={p.id}
                      className={`flex items-center justify-between px-3 py-2 rounded-lg border transition-colors ${inEvent ? "opacity-50 border-border" : "border-border hover:bg-muted/40 cursor-pointer"}`}
                      onClick={() => !inEvent && associatePerson(p)}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{p.full_name}</p>
                        <p className="text-xs text-muted-foreground truncate">{p.contact_email || "sem e-mail"}</p>
                      </div>
                      {inEvent ? (
                        <span className="text-xs text-muted-foreground shrink-0 ml-2">Já no evento</span>
                      ) : (
                        <Button size="sm" variant="outline" className="shrink-0 ml-2" disabled={associating} onClick={(e) => { e.stopPropagation(); associatePerson(p); }}>
                          Associar
                        </Button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" onClick={onClose} className="flex-1">Cancelar</Button>
          <Button variant="outline" className="flex-1 gap-1" onClick={() => setStep("create")}>
            <Plus className="w-4 h-4" /> Criar nova pessoa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}