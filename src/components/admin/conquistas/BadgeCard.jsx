/**
 * Card de badge da matriz de conquistas (ícone, título, descrição automática e
 * menu de contexto: editar/ativar/desativar/excluir).
 */
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MoreVertical, Pencil, ToggleLeft, ToggleRight, Trash2 } from "lucide-react";
import { CAT_COLORS, gerarDescricao } from "@/components/admin/conquistas/badgeModel";

export default function BadgeCard({ badge, hasAccess, onEdit, onToggle, onDelete }) {
  const catColors = CAT_COLORS[badge.categoria] || {};
  const descricao = gerarDescricao(badge.criterio_tipo, badge.acao_referencia, badge.valor_meta);

  return (
    <div className={`relative rounded-xl border ${catColors.border || "border-border"} ${badge.ativo ? (catColors.bg || "bg-card") : "bg-muted/30"} p-3 flex flex-col items-center gap-1.5 min-h-[120px] transition-all`}>
      {/* Ícone */}
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center text-2xl shrink-0 transition-all"
        style={{
          backgroundColor: badge.ativo ? (badge.icone_cor || "#6366f1") + "22" : "#e5e7eb",
          filter: badge.ativo ? "none" : "grayscale(1)",
        }}
      >
        {badge.icone_emoji || "🏅"}
      </div>

      {/* Título */}
      <p className={`text-xs font-medium text-center leading-tight ${badge.ativo ? "text-foreground" : "text-muted-foreground"}`}>
        {badge.titulo}
      </p>

      {/* Descrição automática */}
      {descricao && (
        <p className="text-[10px] text-center leading-snug text-muted-foreground/80 px-1">
          {descricao}
        </p>
      )}

      {/* Menu kebab */}
      {hasAccess && (
        <div className="absolute top-1 right-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6 opacity-60 hover:opacity-100">
                <MoreVertical className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(badge)}>
                <Pencil className="w-3.5 h-3.5 mr-2" /> Editar
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onToggle(badge)}>
                {badge.ativo
                  ? <><ToggleLeft className="w-3.5 h-3.5 mr-2" /> Desativar</>
                  : <><ToggleRight className="w-3.5 h-3.5 mr-2" /> Ativar</>}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onDelete(badge)} className="text-destructive focus:text-destructive">
                <Trash2 className="w-3.5 h-3.5 mr-2" /> Excluir badge
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}