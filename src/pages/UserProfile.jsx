import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Pencil, Camera, Mail, Star, Award, Users, Trophy, ShoppingBag,
  ToggleLeft, ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { calcCompleteness } from "@/lib/profileCompleteness";

function UserAvatar({ src, name, size = "lg" }) {
  const initials = name
    ? name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()
    : "?";
  const cls = size === "lg" ? "w-24 h-24 text-2xl" : "w-8 h-8 text-sm";
  if (src) {
    return <img src={src} alt={name} className={`${cls} rounded-full object-cover ring-2 ring-border`} />;
  }
  return (
    <div className={`${cls} rounded-full bg-primary/10 text-primary font-display font-bold flex items-center justify-center ring-2 ring-border`}>
      {initials}
    </div>
  );
}

const MINI_DASHBOARD_CARDS = [
  { label: "Pontos", icon: Star },
  { label: "Badges", icon: Award },
  { label: "Conexões", icon: Users },
  { label: "Ranking", icon: Trophy },
  { label: "Resgates", icon: ShoppingBag },
];

export default function UserProfile() {
  const { user, refreshUser } = useAuth();
  const queryClient = useQueryClient();
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(null); // optimistic local override

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

  const completeness = calcCompleteness(participant);
  const displayAvatar = avatarUrl ?? user?.photo_url;
  const roleLabel = user?.role === "admin" ? "Admin Global" : user?.role === "manager" ? "Gerente" : "Usuário";

  const handleAvatarChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // reset input so same file can be re-selected
    e.target.value = "";

    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) {
      toast.error("Formato não suportado. Use jpg, png ou webp.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Arquivo muito grande. Limite: 5MB.");
      return;
    }

    setUploading(true);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      await base44.auth.updateMe({ photo_url: file_url });
      // Atualizar optimisticamente e depois sincronizar context
      setAvatarUrl(file_url);
      await refreshUser();
      toast.success("Foto atualizada!");
    } catch (err) {
      toast.error("Erro ao enviar foto. Tente novamente.");
    } finally {
      setUploading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Card principal do perfil */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-start gap-5">
            {/* Avatar com botão câmera */}
            <div className="relative shrink-0">
              <UserAvatar src={displayAvatar} name={user?.full_name} size="lg" />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow hover:bg-primary/90 transition-colors disabled:opacity-60"
                aria-label="Alterar foto"
              >
                {uploading
                  ? <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  : <Camera className="w-3.5 h-3.5" />
                }
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h1 className="text-xl font-display font-bold truncate">{user?.full_name}</h1>
                  <Badge variant="outline" className="mt-1 text-xs">{roleLabel}</Badge>
                </div>
                <Link to="/profile/edit">
                  <Button variant="outline" size="icon" className="shrink-0" aria-label="Editar perfil">
                    <Pencil className="w-4 h-4" />
                  </Button>
                </Link>
              </div>

              <div className="flex items-center gap-1.5 mt-3 text-sm text-muted-foreground">
                <Mail className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{user?.email}</span>
              </div>

              {participant && (
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {participant.company && (
                    <span>{participant.company}{participant.job_title ? ` · ${participant.job_title}` : ""}</span>
                  )}
                  {participant.phone && <span>{participant.phone}</span>}
                </div>
              )}
            </div>
          </div>

          {/* Completude — dentro do card principal, abaixo do e-mail */}
          <div className="border-t border-border pt-4 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground font-medium">Completude do perfil</span>
              <span className="font-display font-bold text-primary">{completeness}%</span>
            </div>
            <Progress value={completeness} className="h-1.5" />
          </div>
        </CardContent>
      </Card>

      {/* Mini Dashboard — somente layout */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm">Meu desempenho</CardTitle>
            <div className="flex items-center gap-2 opacity-40 pointer-events-none select-none">
              <div className="flex items-center gap-1 border rounded-md px-2 py-1 text-xs">
                <ToggleLeft className="w-3.5 h-3.5" />
                <span>Geral</span>
              </div>
              <div className="flex items-center gap-1 border rounded-md px-2 py-1 text-xs">
                <span>Por evento</span>
                <ChevronDown className="w-3 h-3" />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {MINI_DASHBOARD_CARDS.map(({ label, icon: Icon }) => (
              <div key={label} className="rounded-xl border border-border bg-muted/30 p-4 flex flex-col items-center gap-2 text-center">
                <Icon className="w-5 h-5 text-muted-foreground/60" />
                <span className="text-xs font-medium text-muted-foreground">{label}</span>
                <span className="text-xs text-muted-foreground/60">Em breve</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}