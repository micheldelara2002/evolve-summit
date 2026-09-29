/**
 * Tabela paginada de participantes do evento: chips de papéis, coluna parceiro,
 * toggle de check-in e menu de contexto por linha.
 */
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MoreVertical, Pencil, Trash2, UserCog } from "lucide-react";
import { t } from "@/lib/i18n";
import { ROLE_COLORS, ROLE_LABELS } from "@/components/admin/pessoas/roleConstants";

export default function PessoasTable({
  rows, filteredCount, totalPages, page, onPageChange,
  hasAccess, onToggleCheckin, onEditData, onEditRoles, onRemove,
}) {
  return (
    <>
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/60 text-left">
                <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground">Nome</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground hidden sm:table-cell">CPF</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground hidden md:table-cell">E-mail</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground hidden lg:table-cell">Telefone</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground">Papéis</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground hidden md:table-cell">Parceiro</th>
                {hasAccess && <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-center">Check-in</th>}
                {hasAccess && <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-right">Ações</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((pessoa, idx) => (
                <tr key={pessoa.id} className={`border-t border-border ${idx % 2 === 0 ? "bg-card" : "bg-muted/20"} hover:bg-muted/40 transition-colors`}>
                  <td className="px-3 py-2.5 text-sm font-medium">{pessoa.full_name}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground hidden sm:table-cell font-mono">{pessoa.cpf || "—"}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground hidden md:table-cell max-w-[160px] truncate">{pessoa.email}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">{pessoa.phone || "—"}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {pessoa.derivedRoles.map((role) => (
                        <span key={role} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_COLORS[role] || "bg-muted text-muted-foreground"}`}>
                          {ROLE_LABELS[role] || role}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground hidden md:table-cell">{pessoa.partnerName || "—"}</td>
                  {hasAccess && (
                    <td className="px-3 py-2.5 text-center">
                      <TooltipProvider delayDuration={300}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="inline-flex items-center justify-center">
                              <Switch
                                checked={pessoa.checkin_status === "confirmed"}
                                onCheckedChange={() => onToggleCheckin(pessoa)}
                              />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            {pessoa.checkin_status === "confirmed"
                              ? `Confirmado em ${pessoa.checkin_at ? new Date(pessoa.checkin_at).toLocaleString("pt-BR") : ""} — clique para desfazer`
                              : "Pendente — clique para confirmar check-in"}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </td>
                  )}
                  {hasAccess && (
                    <td className="px-3 py-2.5 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <MoreVertical className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => onEditData(pessoa)}>
                            <Pencil className="w-4 h-4 mr-2" /> Editar dados
                          </DropdownMenuItem>
                          {pessoa.role_in_event !== "partner_rep" && (
                            <DropdownMenuItem onClick={() => onEditRoles(pessoa)}>
                              <UserCog className="w-4 h-4 mr-2" /> Editar papéis
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem className="text-destructive" onClick={() => onRemove(pessoa)}>
                            <Trash2 className="w-4 h-4 mr-2" /> Remover do evento
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filteredCount === 0 && (
          <p className="text-center text-muted-foreground py-8 text-sm">{t("common.noData")}</p>
        )}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{filteredCount} pessoa(s)</span>
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" disabled={page === 1} onClick={() => onPageChange(page - 1)}>Anterior</Button>
            <span className="px-2">pág. {page}/{totalPages}</span>
            <Button size="sm" variant="outline" disabled={page === totalPages} onClick={() => onPageChange(page + 1)}>Próxima</Button>
          </div>
        )}
      </div>
    </>
  );
}