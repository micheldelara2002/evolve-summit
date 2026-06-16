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
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";

const REQUIRED_FIELDS = [
  { key: "full_name", label: "Nome completo", type: "text" },
  { key: "cpf",       label: "CPF",           type: "text", placeholder: "000.000.000-00" },
];

const OPTIONAL_FIELDS = [
  { key: "phone",     label: "Telefone",  type: "text" },
  { key: "company",   label: "Empresa",   type: "text" },
  { key: "job_title", label: "Cargo",     type: "text" },
  { key: "linkedin",  label: "LinkedIn",  type: "url",  placeholder: "https://linkedin.com/in/..." },
  { key: "instagram", label: "Instagram", type: "url",  placeholder: "https://instagram.com/..." },
  { key: "youtube",   label: "YouTube",   type: "url",  placeholder: "https://youtube.com/..." },
  { key: "website",   label: "Site",      type: "url",  placeholder: "https://..." },
  { key: "bio",       label: "Sobre mim", type: "textarea" },
];

// Todos os campos do formulário (exceto email que é somente leitura)
const ALL_KEYS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS].map((f) => f.key);

function buildInitialForm(user, participant) {
  return {
    full_name: user?.full_name || "",
    cpf:       participant?.cpf       || "",
    phone:     participant?.phone     || "",
    company:   participant?.company   || "",
    job_title: participant?.job_title || "",
    linkedin:  participant?.linkedin  || "",
    instagram: participant?.instagram || "",
    youtube:   participant?.youtube   || "",
    website:   participant?.website   || "",
    bio:       participant?.bio       || "",
  };
}

export default function UserProfileEdit() {
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});
  const [form, setForm] = useState(null);

  const { data: participant, isLoading } = useQuery({
    queryKey: ["my_participant", user?.id],
    queryFn: async () => {
      if (!user) return null;
      const list = await base44.entities.Participant.filter({ email: user.email, is_deleted: false });
      if (!list.length) return null;
      return list.sort((a, b) => new Date(b.created_date) - new Date(a.created_date))[0];
    },
    enabled: !!user,
  });

  // Inicializar form uma vez após carregamento
  useEffect(() => {
    if (!isLoading && form === null) {
      setForm(buildInitialForm(user, participant));
    }
  }, [isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: null }));
  };

  const validate = () => {
    const errs = {};
    if (!form.full_name?.trim()) errs.full_name = "Nome é obrigatório.";
    if (!form.cpf?.trim())       errs.cpf       = "CPF é obrigatório.";
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
      // Montar payload com trim em todos os campos string
      const payload = {};
      ALL_KEYS.forEach((key) => {
        payload[key] = typeof form[key] === "string" ? form[key].trim() : (form[key] ?? "");
      });

      if (participant?.id) {
        // Atualizar registro existente
        await base44.entities.Participant.update(participant.id, payload);
      } else {
        // Criar registro novo — email obrigatório na entidade
        await base44.entities.Participant.create({
          ...payload,
          email: user.email,
          event_id: "global", // placeholder; participant sem evento específico
        });
      }

      // Sincronizar nome no user do sistema se mudou
      if (payload.full_name !== user?.full_name) {
        await base44.auth.updateMe({ full_name: payload.full_name });
      }

      // Forçar refetch do participant e do user no context
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my_participant", user?.id] }),
        refreshUser(),
      ]);

      toast.success("Perfil atualizado com sucesso!");
      navigate("/profile");
    } catch (err) {
      toast.error("Erro ao salvar: " + (err.message || "tente novamente."));
    } finally {
      setSaving(false);
    }
  };

  if (isLoading || form === null) {
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

      {/* E-mail somente leitura */}
      <Card>
        <CardContent className="pt-4 pb-4">
          <Label className="text-xs text-muted-foreground mb-1.5 block">E-mail (não editável)</Label>
          <Input value={user?.email || ""} disabled className="bg-muted/30 text-muted-foreground" />
        </CardContent>
      </Card>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Campos obrigatórios */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Dados obrigatórios</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {REQUIRED_FIELDS.map(({ key, label, type, placeholder }) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={key}>
                  {label} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id={key}
                  type={type}
                  value={form[key]}
                  onChange={(e) => handleChange(key, e.target.value)}
                  placeholder={placeholder}
                  className={errors[key] ? "border-destructive focus-visible:ring-destructive" : ""}
                />
                {errors[key] && <p className="text-xs text-destructive">{errors[key]}</p>}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Campos opcionais */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Informações adicionais</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {OPTIONAL_FIELDS.map(({ key, label, type, placeholder }) => (
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