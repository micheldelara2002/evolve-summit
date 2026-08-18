import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Users, Search, Plus, MoreVertical, Star, Trash2, UserCheck, UserX, Pencil,
} from "lucide-react";
import { toast } from "sonner";
import PersonFormDialog from "@/components/admin/PersonFormDialog";
import PageHeader from "@/components/layout/PageHeader";

const COUNTRY_OPTIONS = [
  { value: "BR", label: "Brasil" },
  { value: "US", label: "EUA" },
  { value: "PT", label: "Portugal" },
  { value: "AR", label: "Argentina" },
  { value: "OTHER", label: "Outro" },
];

const DOC_TYPE_OPTIONS = [
  { value: "CPF", label: "CPF" },
  { value: "RG", label: "RG" },
  { value: "PASSAPORTE", label: "Passaporte" },
  { value: "CNH", label: "CNH" },
  { value: "OTHER", label: "Outro" },
];

function sanitizeDoc(n) { return (n || "").replace(/\D/g, ""); }

// ────────────────────────────────────────────────────────────────────
// PersonDocumentsDialog
// ────────────────────────────────────────────────────────────────────
function PersonDocumentsDialog({ person, onClose }) {
  const [newDoc, setNewDoc] = useState({ country_code: "BR", document_type: "CPF", document_number: "" });
  const [adding, setAdding] = useState(false);

  const { data: docs = [], refetch } = useQuery({
    queryKey: ["person_docs", person.id],
    queryFn: () => base44.entities.PersonDocument.filter({ person_id: person.id }),
  });

  const handleAdd = async () => {
    if (!newDoc.document_number.trim()) { toast.error("Informe o número."); return; }
    const sanitized = sanitizeDoc(newDoc.document_number);
    const dup = docs.find(
      (d) => sanitizeDoc(d.document_number) === sanitized &&
             d.document_type === newDoc.document_type &&
             d.country_code === newDoc.country_code
    );
    if (dup) { toast.error("Documento já cadastrado."); return; }
    const hasPrimary = docs.some((d) => d.is_primary);
    await base44.entities.PersonDocument.create({
      ...newDoc,
      person_id: person.id,
      document_number: newDoc.document_number.trim(),
      is_primary: !hasPrimary,
      status: "active",
    });
    setNewDoc({ country_code: "BR", document_type: "CPF", document_number: "" });
    setAdding(false);
    refetch();
    toast.success("Documento adicionado.");
  };

  const handleDelete = async (id) => {
    await base44.entities.PersonDocument.delete(id);
    refetch();
  };

  const handleSetPrimary = async (id) => {
    const others = docs.filter((d) => d.id !== id && d.is_primary);
    await Promise.all(others.map((d) => base44.entities.PersonDocument.update(d.id, { is_primary: false })));
    await base44.entities.PersonDocument.update(id, { is_primary: true });
    refetch();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Documentos — {person.full_name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          {docs.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">Nenhum documento cadastrado.</p>
          )}
          {docs.map((doc) => (
            <div key={doc.id} className="flex items-center justify-between border rounded-lg px-3 py-2">
              <div className="text-sm">
                <span className="font-medium">{doc.document_type}</span>
                <span className="text-muted-foreground ml-2">{doc.document_number}</span>
                <span className="text-muted-foreground ml-1 text-xs">({doc.country_code})</span>
                {doc.is_primary && <Badge variant="secondary" className="ml-2 text-[10px]">Principal</Badge>}
              </div>
              <div className="flex gap-1">
                {!doc.is_primary && (
                  <Button type="button" variant="ghost" size="icon" className="w-7 h-7" onClick={() => handleSetPrimary(doc.id)}>
                    <Star className="w-3.5 h-3.5" />
                  </Button>
                )}
                <Button type="button" variant="ghost" size="icon" className="w-7 h-7 text-destructive" onClick={() => handleDelete(doc.id)}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}

          {adding ? (
            <div className="border border-dashed rounded-lg p-3 space-y-2 bg-muted/20">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">País</Label>
                  <select
                    className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm mt-1"
                    value={newDoc.country_code}
                    onChange={(e) => setNewDoc((p) => ({ ...p, country_code: e.target.value }))}
                  >
                    {COUNTRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <Label className="text-xs">Tipo</Label>
                  <select
                    className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm mt-1"
                    value={newDoc.document_type}
                    onChange={(e) => setNewDoc((p) => ({ ...p, document_type: e.target.value }))}
                  >
                    {DOC_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>
              <Input
                placeholder="Número do documento"
                value={newDoc.document_number}
                onChange={(e) => setNewDoc((p) => ({ ...p, document_number: e.target.value }))}
              />
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => setAdding(false)}>Cancelar</Button>
                <Button type="button" size="sm" className="flex-1" onClick={handleAdd}>Salvar</Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="outline" size="sm" className="w-full gap-1" onClick={() => setAdding(true)}>
              <Plus className="w-3.5 h-3.5" /> Adicionar documento
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────────────
// Main Page
// ────────────────────────────────────────────────────────────────────
const PAGE_SIZE = 20;

export default function AdminPeople() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filterActive, setFilterActive] = useState("all"); // all | active | inactive
  const [page, setPage] = useState(1);
  const [editingPerson, setEditingPerson] = useState(null);    // null = closed, {} = new, {id,...} = edit
  const [docsForPerson, setDocsForPerson] = useState(null);

  const { data: allPeople = [], isLoading } = useQuery({
    queryKey: ["admin_people"],
    queryFn: () => base44.entities.Person.list("-created_date", 500),
  });

  // Buscar users para mostrar status de acesso
  const { data: allUsers = [] } = useQuery({
    queryKey: ["admin_users_for_people"],
    queryFn: () => base44.entities.User.list(),
  });

  const linkedPersonIds = new Set(allUsers.filter((u) => u.person_id).map((u) => u.person_id));

  // Filtros client-side
  const filtered = allPeople.filter((p) => {
    const q = search.toLowerCase();
    const matchSearch = !q ||
      p.full_name?.toLowerCase().includes(q) ||
      p.contact_email?.toLowerCase().includes(q);
    const matchActive =
      filterActive === "all" ||
      (filterActive === "active" && p.is_active !== false) ||
      (filterActive === "inactive" && p.is_active === false);
    return matchSearch && matchActive;
  });

  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  const handleInactivate = async (person) => {
    await base44.entities.Person.update(person.id, { is_active: false });
    queryClient.invalidateQueries({ queryKey: ["admin_people"] });
    toast.success("Pessoa inativada.");
  };

  const handleActivate = async (person) => {
    await base44.entities.Person.update(person.id, { is_active: true });
    queryClient.invalidateQueries({ queryKey: ["admin_people"] });
    toast.success("Pessoa reativada.");
  };

  const onSaved = (_person) => {
    queryClient.invalidateQueries({ queryKey: ["admin_people"] });
    setEditingPerson(null);
    toast.success("Pessoa salva.");
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <PageHeader
        icon={Users}
        title="Gestão de Pessoas"
        subtitle={`${filtered.length} pessoa(s) encontrada(s)`}
        tone="success"
        actions={
          <Button onClick={() => setEditingPerson({})} className="gap-2">
            <Plus className="w-4 h-4" /> Nova Pessoa
          </Button>
        }
      />

      {/* Filtros */}
      <Card>
        <CardContent className="pt-4 pb-4 flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-52">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por nome, e-mail ou documento..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="pl-9"
            />
          </div>
          <div className="flex gap-1">
            {[
              { value: "all", label: "Todos" },
              { value: "active", label: "Ativos" },
              { value: "inactive", label: "Inativos" },
            ].map((opt) => (
              <Button
                key={opt.value}
                variant={filterActive === opt.value ? "default" : "outline"}
                size="sm"
                onClick={() => { setFilterActive(opt.value); setPage(1); }}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Lista */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : paginated.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <Users className="w-10 h-10 text-muted-foreground/40" />
          <p className="text-muted-foreground">Nenhuma pessoa encontrada.</p>
          <Button variant="outline" onClick={() => setEditingPerson({})}>Criar primeira pessoa</Button>
        </div>
      ) : (
        <div className="space-y-2">
          {paginated.map((person) => {
            const hasAccess = linkedPersonIds.has(person.id);
            return (
              <Card key={person.id} className={person.is_active === false ? "opacity-60" : ""}>
                <CardContent className="py-3 px-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-full bg-primary/10 text-primary text-sm font-display font-bold flex items-center justify-center shrink-0">
                        {person.full_name?.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?"}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm truncate">{person.full_name}</span>
                          {person.is_active === false && (
                            <Badge variant="outline" className="text-[10px] py-0">Inativo</Badge>
                          )}
                          <Badge
                            variant={hasAccess ? "secondary" : "outline"}
                            className="text-[10px] py-0 gap-1"
                          >
                            {hasAccess ? (
                              <><UserCheck className="w-3 h-3" /> Com acesso</>
                            ) : (
                              <><UserX className="w-3 h-3" /> Sem acesso</>
                            )}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {person.contact_email || person.company || "—"}
                        </div>
                      </div>
                    </div>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="shrink-0">
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditingPerson(person)}>
                          <Pencil className="w-4 h-4 mr-2" /> Editar
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setDocsForPerson(person)}>
                          <Star className="w-4 h-4 mr-2" /> Documentos
                        </DropdownMenuItem>
                        {person.is_active !== false ? (
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => handleInactivate(person)}
                          >
                            <UserX className="w-4 h-4 mr-2" /> Inativar
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onClick={() => handleActivate(person)}>
                            <UserCheck className="w-4 h-4 mr-2" /> Reativar
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            Anterior
          </Button>
          <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}>
            Próxima
          </Button>
        </div>
      )}

      {/* Dialogs */}
      {editingPerson !== null && (
        <PersonFormDialog
          person={editingPerson?.id ? editingPerson : null}
          onClose={() => setEditingPerson(null)}
          onSaved={onSaved}
        />
      )}
      {docsForPerson && (
        <PersonDocumentsDialog
          person={docsForPerson}
          onClose={() => setDocsForPerson(null)}
        />
      )}
    </div>
  );
}