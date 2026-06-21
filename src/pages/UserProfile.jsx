import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Pencil, Camera, Mail, Star, Award, Users, Trophy, ShoppingBag,
} from "lucide-react";
import { toast } from "sonner";
import { calcCompleteness } from "@/lib/profileCompleteness";
import PointsModal from "@/components/profile/PointsModal";
import ResgatesModal from "@/components/profile/ResgatesModal";

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

const ROLE_LABELS = {
  admin: "Admin Global",
  member: "Membro",
  partner_manager: "Gestor Parceiro",
};

export default function UserProfile() {
  const { user, refreshUser } = useAuth();
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [showPoints, setShowPoints] = useState(false);
  const [showResgates, setShowResgates] = useState(false);

  const { data: person, isLoading } = useQuery({
    queryKey: ["my_person", user?.person_id],
    queryFn: async () => {
      if (!user?.person_id) return null;
      const list = await base44.entities.Person.filter({ id: user.person_id });
      return list[0] ?? null;
    },
    enabled: !!user?.person_id,
  });

  const completeness = calcCompleteness(person);
  const displayAvatar = avatarUrl ?? person?.photo_url ?? user?.photo_url;
  const displayName = person?.full_name || user?.full_name || user?.email;
  const roleLabel = ROLE_LABELS[user?.role] ?? "Membro";

  const handleAvatarChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
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
      if (person?.id) {
        await base44.entities.Person.update(person.id, { photo_url: file_url });
      }
      await base44.auth.updateMe({ photo_url: file_url });
      setAvatarUrl(file_url);
      await refreshUser();
      toast.success("Foto atualizada!");
    } catch {
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

  if (!user?.person_id) {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Card>
          <CardContent className="pt-8 pb-8 flex flex-col items-center gap-4 text-center">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
              <Users className="w-7 h-7 text-muted-foreground" />
            </div>
            <div>
              <h2 className="text-lg font-display font-bold">Perfil não configurado</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Complete seu perfil para aparecer em eventos e conectar com pessoas.
              </p>
            </div>
            <Link to="/profile/edit">
              <Button>Completar perfil</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const MINI_DASHBOARD_CARDS = [
    { label: "Pontos", icon: Star, onClick: () => setShowPoints(true), active: true },
    { label: "Badges", icon: Award, onClick: null, active: false },
    { label: "Conexões", icon: Users, onClick: null, active: false },
    { label: "Ranking", icon: Trophy, onClick: null, active: false },
    { label: "Resgates", icon: ShoppingBag, onClick: () => setShowResgates(true), active: true },
  ];

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Card principal */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-start gap-5">
            <div className="relative shrink-0">
              <UserAvatar src={displayAvatar} name={displayName} size="lg" />
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

            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h1 className="text-xl font-display font-bold truncate">{displayName}</h1>
                  <Badge variant="outline" className="mt-1 text-xs">{roleLabel}</Badge>
                </div>
                <Link to="/profile/edit">
                  <Button variant="outline" size="icon" className="shrink-0" aria-label="Editar perfil">
                    <Pencil className="w-4 h-4" />
                  </Button>
                </Link>
              </div>

              {/* Email de autenticação */}
              <div className="flex items-center gap-1.5 mt-3 text-sm text-muted-foreground">
                <Mail className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{user?.email}</span>
                <Badge variant="outline" className="text-[10px] py-0 px-1 ml-1">login</Badge>
              </div>

              {/* Email de contato */}
              {person?.contact_email && person.contact_email !== user?.email && (
                <div className="flex items-center gap-1.5 mt-1 text-sm text-muted-foreground">
                  <Mail className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{person.contact_email}</span>
                  <Badge variant="outline" className="text-[10px] py-0 px-1 ml-1">contato</Badge>
                </div>
              )}

              {/* Empresa / cargo / telefone */}
              {person && (
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {person.company && (
                    <span>{person.company}{person.job_title ? ` · ${person.job_title}` : ""}</span>
                  )}
                  {person.phone && <span>{person.phone}</span>}
                </div>
              )}
            </div>
          </div>

          {/* Bio */}
          {person?.bio && (
            <p className="text-sm text-muted-foreground border-t border-border pt-4">{person.bio}</p>
          )}

          {/* Completude */}
          <div className="border-t border-border pt-4 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground font-medium">Completude do perfil</span>
              <span className="font-display font-bold text-primary">{completeness}%</span>
            </div>
            <Progress value={completeness} className="h-1.5" />
          </div>
        </CardContent>
      </Card>

      {/* Mini Dashboard */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Meu desempenho</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {MINI_DASHBOARD_CARDS.map(({ label, icon: Icon, onClick, active }) => (
              <button
                key={label}
                onClick={onClick}
                disabled={!active}
                className={`rounded-xl border border-border p-4 flex flex-col items-center gap-2 text-center transition-all ${
                  active
                    ? "bg-card hover:bg-muted/50 hover:shadow-sm cursor-pointer"
                    : "bg-muted/30 opacity-50 cursor-default"
                }`}
              >
                <Icon className={`w-5 h-5 ${active ? "text-primary" : "text-muted-foreground/60"}`} />
                <span className="text-xs font-medium">{label}</span>
                {!active && <span className="text-xs text-muted-foreground/60">Em breve</span>}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Modais */}
      <PointsModal
        open={showPoints}
        onClose={() => setShowPoints(false)}
        personId={user?.person_id}
        userEmail={user?.email}
      />
      <ResgatesModal
        open={showResgates}
        onClose={() => setShowResgates(false)}
        personId={user?.person_id}
        userEmail={user?.email}
      />
    </div>
  );
}