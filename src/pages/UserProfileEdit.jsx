import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Plus, Trash2, Star } from "lucide-react";
import { toast } from "sonner";
import { processAction } from "@/lib/scoringEngine";
import { calcCompleteness } from "@/lib/profileCompleteness";

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

const PERSON_FIELDS = [
  { key: "phone",         label: "Telefone",          type: "text" },
  { key: "company",       label: "Empresa",           type: "text" },
  { key: "job_title",     label: "Cargo",             type: "text" },
  { key: "linkedin",      label: "LinkedIn",          type: "url", placeholder: "https://linkedin.com/in/..." },
  { key: "instagram",     label: "Instagram",         type: "url", placeholder: "https://instagram.com/..." },
  { key: "youtube",       label: "YouTube",           type: "url", placeholder: "https://youtube.com/..." },
  { key: "website",       label: "Site",              type: "url", placeholder: "https://..." },
  { key: "bio",           label: "Sobre mim",         type: "textarea" },
];

function sanitizeDoc(number) {
  return (number || "").replace(/\D/g, "");
}

function buildForm(person) {
  return {
    full_name:     person?.full_name     || "",
    contact_email: person?.contact_email || "",
    phone:         person?.phone         || "",
    company:       person?.company       || "",
    job_title:     person?.job_title     || "",
    linkedin:      person?.linkedin      || "",
    instagram:     person?.instagram     || "",
    youtube:       person?.youtube       || "",
    website:       person?.website       || "",
    bio:           person?.bio           || "",
  };
}

export default function UserProfileEdit() {
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});
  const [form, setForm] = useState(null);
  const [newDoc, setNewDoc] = useState({ country_code: "BR", document_type: "CPF", document_number: "" });
  const [addingDoc, setAddingDoc] = useState(false);

  // Carregar Person vinculada ao user
  const { data: person, isLoading: loadingPerson } = useQuery({
    queryKey: ["my_person", user?.person_id],
    queryFn: async () => {
      if (!user?.person_id) return null;
      const list = await base44.entities.Person.filter({ id: user.person_id });
      return list[0] ?? null;
    },
    enabled: !!user?.person_id,
  });

  // Carregar documentos
  const { data: documents = [], isLoading: loadingDocs, refetch: refetchDocs } = useQuery({
    queryKey: ["my_person_docs", person?.id],
    queryFn: () => base44.entities.PersonDocument.filter({ person_id: person.id }),
    enabled: !!person?.id,
  });

  // Inicializar form uma vez após carregamento
  useEffect(() => {
    if (!loadingPerson && form === null) {
      setForm(buildForm(person));
    }
  }, [loadingPerson]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: null }));
  };

  const validate = () => {
    const errs = {};
    if (!form.full_name?.trim()) errs.full_name = "Nome é obrigatório.";
    return errs;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setSaving(true);
    try {
      const payload = {};
      Object.keys(form).forEach((key) => {
        payload[key] = typeof form[key] === "string" ? form[key].trim() : (form[key] ?? "");
      });

      let personId = person?.id;

      if (personId) {
        await base44.entities.Person.update(personId, payload);
      } else {
        // Criar Person novo
        const created = await base44.entities.Person.create(payload);
        personId = created.id;
        // Vincular ao user
        await base44.auth.updateMe({ person_id: personId });
      }

      // Sincronização de nome em mão única: person.full_name → users.name
      await base44.auth.updateMe({ full_name: payload.full_name });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my_person", user?.person_id] }),
        queryClient.invalidateQueries({ queryKey: ["my_person", personId] }),
        refreshUser(),
      ]);

      // Trigger completude_perfil for all events the user is participating in
      try {
        if (personId) {
          const updatedPersons = await base44.entities.Person.filter({ id: personId });
          const updatedPerson = updatedPersons[0];
          const completeness = calcCompleteness(updatedPerson);
          if (completeness > 0) {
            const participants = await base44.entities.Participant.filter({ person_id: personId, is_deleted: false });
            await Promise.all(
              participants.map((p) =>
                processAction({
                  eventId: p.event_id,
                  participantId: p.id,
                  personId: personId,
                  acao: "completude_perfil",
                })
              )
            );
          }
        }
      } catch (e) { /* best-effort — don't block profile save */ }

      toast.success("Perfil atualizado com sucesso!");
      navigate("/profile");
    } catch (err) {
      toast.error("Erro ao salvar: " + (err.message || "tente novamente."));
    } finally {
      setSaving(false);
    }
  };

  // --- Documentos ---
  const handleAddDoc = async () => {
    if (!newDoc.document_number.trim()) {
      toast.error("Informe o número do documento.");
      return;
    }

    // Garantir que temos um person_id (criar person se ainda não existe)
    let personId = person?.id;
    if (!personId) {
      if (!form?.full_name?.trim()) {
        toast.error("Preencha o nome completo antes de adicionar documentos.");
        return;
      }
      const payload = {};
      Object.keys(form).forEach((key) => {
        payload[key] = typeof form[key] === "string" ? form[key].trim() : (form[key] ?? "");
      });
      const created = await base44.entities.Person.create(payload);
      personId = created.id;
      await base44.auth.updateMe({ person_id: personId, full_name: payload.full_name });
      await refreshUser();
      queryClient.invalidateQueries({ queryKey: ["my_person"] });
    }

    // Checar unicidade (sanitizado)
    const sanitized = sanitizeDoc(newDoc.document_number);
    const duplicate = documents.find(
      (d) =>
        sanitizeDoc(d.document_number) === sanitized &&
        d.document_type === newDoc.document_type &&
        d.country_code === newDoc.country_code
    );
    if (duplicate) {
      toast.error("Documento já cadastrado para essa pessoa.");
      return;
    }

    // Garantir no máximo 1 primário
    const hasPrimary = documents.some((d) => d.is_primary);

    try {
      await base44.entities.PersonDocument.create({
        person_id: personId,
        country_code: newDoc.country_code,
        document_type: newDoc.document_type,
        document_number: newDoc.document_number.trim(),
        is_primary: !hasPrimary, // primeiro documento vira primário automaticamente
        status: "active",
      });
      setNewDoc({ country_code: "BR", document_type: "CPF", document_number: "" });
      setAddingDoc(false);
      refetchDocs();
      toast.success("Documento adicionado.");
    } catch (err) {
      toast.error("Erro ao salvar documento: " + err.message);
    }
  };

  const handleDeleteDoc = async (docId) => {
    await base44.entities.PersonDocument.delete(docId);
    refetchDocs();
    toast.success("Documento removido.");
  };

  const handleSetPrimary = async (docId) => {
    // Remover primário dos outros
    const others = documents.filter((d) => d.id !== docId && d.is_primary);
    await Promise.all(others.map((d) => base44.entities.PersonDocument.update(d.id, { is_primary: false })));
    await base44.entities.PersonDocument.update(docId, { is_primary: true });
    refetchDocs();
  };

  if (loadingPerson || form === null) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/profile")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h1 className="text-xl font-display font-bold">Editar Perfil</h1>
      </div>

      {/* Email de autenticação — somente leitura */}
      <Card>
        <CardContent className="pt-4 pb-4 space-y-1">
          <Label className="text-xs text-muted-foreground block">E-mail de autenticação (não editável)</Label>
          <Input value={user?.email || ""} disabled className="bg-muted/30 text-muted-foreground" />
        </CardContent>
      </Card>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Dados principais */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Dados principais</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Nome obrigatório */}
            <div className="space-y-1.5">
              <Label htmlFor="full_name">
                Nome completo <span className="text-destructive">*</span>
              </Label>
              <Input
                id="full_name"
                value={form.full_name}
                onChange={(e) => handleChange("full_name", e.target.value)}
                className={errors.full_name ? "border-destructive focus-visible:ring-destructive" : ""}
              />
              {errors.full_name && <p className="text-xs text-destructive">{errors.full_name}</p>}
            </div>

            {/* Email de contato — editável */}
            <div className="space-y-1.5">
              <Label htmlFor="contact_email">E-mail de contato</Label>
              <Input
                id="contact_email"
                type="email"
                value={form.contact_email}
                onChange={(e) => handleChange("contact_email", e.target.value)}
                placeholder="seu@email.com"
              />
              <p className="text-xs text-muted-foreground">Diferente do e-mail de login. Visível no seu perfil.</p>
            </div>

            {/* Demais campos */}
            {PERSON_FIELDS.map(({ key, label, type, placeholder }) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={key}>{label}</Label>
                {type === "textarea" ? (
                  <Textarea
                    id={key}
                    value={form[key]}
                    onChange={(e) => handleChange(key, e.target.value)}
                    placeholder={placeholder}
                    rows={3}
                  />
                ) : (
                  <Input
                    id={key}
                    type={type}
                    value={form[key]}
                    onChange={(e) => handleChange(key, e.target.value)}
                    placeholder={placeholder}
                  />
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Documentos */}
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm">Documentos</CardTitle>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1 text-xs"
              onClick={() => setAddingDoc((v) => !v)}
            >
              <Plus className="w-3.5 h-3.5" />
              Adicionar
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {loadingDocs ? (
              <p className="text-xs text-muted-foreground">Carregando...</p>
            ) : documents.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nenhum documento cadastrado.</p>
            ) : (
              documents.map((doc) => (
                <div key={doc.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                  <div className="text-sm">
                    <span className="font-medium">{doc.document_type}</span>
                    <span className="text-muted-foreground ml-2">{doc.document_number}</span>
                    <span className="text-muted-foreground ml-2 text-xs">({doc.country_code})</span>
                    {doc.is_primary && (
                      <Badge className="ml-2 text-[10px] py-0 px-1.5" variant="secondary">
                        Principal
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {!doc.is_primary && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="w-7 h-7"
                        title="Tornar principal"
                        onClick={() => handleSetPrimary(doc.id)}
                      >
                        <Star className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="w-7 h-7 text-destructive hover:text-destructive"
                      onClick={() => handleDeleteDoc(doc.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            )}

            {addingDoc && (
              <div className="rounded-lg border border-dashed border-border p-3 space-y-3 bg-muted/20">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">País</Label>
                    <select
                      className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={newDoc.country_code}
                      onChange={(e) => setNewDoc((p) => ({ ...p, country_code: e.target.value }))}
                    >
                      {COUNTRY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Tipo</Label>
                    <select
                      className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={newDoc.document_type}
                      onChange={(e) => setNewDoc((p) => ({ ...p, document_type: e.target.value }))}
                    >
                      {DOC_TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Número</Label>
                  <Input
                    value={newDoc.document_number}
                    onChange={(e) => setNewDoc((p) => ({ ...p, document_number: e.target.value }))}
                    placeholder="000.000.000-00"
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => setAddingDoc(false)}>
                    Cancelar
                  </Button>
                  <Button type="button" size="sm" className="flex-1" onClick={handleAddDoc}>
                    Salvar documento
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex gap-3">
          <Button type="button" variant="outline" className="flex-1" onClick={() => navigate("/profile")}>
            Cancelar
          </Button>
          <Button type="submit" className="flex-1" disabled={saving}>
            {saving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </form>
    </div>
  );
}