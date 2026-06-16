import { useState } from "react";
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

const FIELDS = [
  { key: "phone",     label: "Telefone",  type: "text" },
  { key: "company",   label: "Empresa",   type: "text" },
  { key: "job_title", label: "Cargo",     type: "text" },
  { key: "linkedin",  label: "LinkedIn",  type: "url",  placeholder: "https://linkedin.com/in/..." },
  { key: "instagram", label: "Instagram", type: "url",  placeholder: "https://instagram.com/..." },
  { key: "youtube",   label: "YouTube",   type: "url",  placeholder: "https://youtube.com/..." },
  { key: "website",   label: "Site",      type: "url",  placeholder: "https://..." },
  { key: "bio",       label: "Sobre mim", type: "textarea" },
];

export default function UserProfileEdit() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

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

  const [form, setForm] = useState(null);

  // Inicializar form quando participant carrega
  if (participant && form === null) {
    const initial = {};
    FIELDS.forEach(({ key }) => { initial[key] = participant[key] || ""; });
    setForm(initial);
  }
  // Se não há participant ainda, inicializar vazio
  if (!participant && !isLoading && form === null) {
    const initial = {};
    FIELDS.forEach(({ key }) => { initial[key] = ""; });
    setForm(initial);
  }

  const handleChange = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (participant) {
        await base44.entities.Participant.update(participant.id, form);
      }
      // Invalidar query para recalcular completude
      queryClient.invalidateQueries({ queryKey: ["my_participant", user?.id] });
      toast.success("Perfil atualizado!");
      navigate("/profile");
    } catch (err) {
      toast.error("Erro ao salvar: " + (err.message || "tente novamente."));
    } finally {
      setSaving(false);
    }
  };

  if (isLoading || form === null) {
    return <div className="flex justify-center py-16"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }

  return (
    <div className="max-w-xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/profile")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h1 className="text-xl font-display font-bold">Editar Perfil</h1>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm text-muted-foreground">E-mail</CardTitle>
        </CardHeader>
        <CardContent>
          <Input value={user?.email || ""} disabled className="bg-muted/30 text-muted-foreground" />
          <p className="text-xs text-muted-foreground mt-1">O e-mail não pode ser alterado aqui.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Informações adicionais</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {FIELDS.map(({ key, label, type, placeholder }) => (
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

            <div className="flex gap-3 pt-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => navigate("/profile")}>
                Cancelar
              </Button>
              <Button type="submit" className="flex-1" disabled={saving}>
                {saving ? "Salvando..." : "Salvar"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}