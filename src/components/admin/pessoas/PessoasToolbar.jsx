/**
 * Barra de ferramentas da tela Pessoas do Evento: busca, filtros de papel e
 * parceiro, e ações (check-in QR, exportar CSV, importar CSV, adicionar pessoa).
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, Upload, Download, QrCode, UserPlus } from "lucide-react";

export default function PessoasToolbar({
  search, onSearchChange,
  filterRole, onFilterRoleChange,
  filterPartner, onFilterPartnerChange,
  partnerNames = [],
  hasAccess,
  onScan, onExport, onImport, onAdd,
}) {
  return (
    <div className="flex flex-wrap gap-2 items-center">
      <div className="relative flex-1 min-w-[160px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input placeholder="Nome, CPF ou e-mail..." value={search} onChange={(e) => onSearchChange(e.target.value)} className="pl-9 h-9" />
      </div>
      <Select value={filterRole} onValueChange={onFilterRoleChange}>
        <SelectTrigger className="h-9 w-36"><SelectValue placeholder="Papel" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todos papéis</SelectItem>
          <SelectItem value="attendee">Participante</SelectItem>
          <SelectItem value="speaker">Palestrante</SelectItem>
          <SelectItem value="team">Equipe</SelectItem>
          <SelectItem value="manager">Gerente</SelectItem>
          <SelectItem value="reviewer">Avaliador</SelectItem>
          <SelectItem value="partner_rep">Representante</SelectItem>
        </SelectContent>
      </Select>
      {partnerNames.length > 0 && (
        <Select value={filterPartner} onValueChange={onFilterPartnerChange}>
          <SelectTrigger className="h-9 w-36"><SelectValue placeholder="Parceiro" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos parceiros</SelectItem>
            {partnerNames.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      <div className="flex gap-2 ml-auto">
        {hasAccess && (
          <Button variant="outline" size="sm" className="gap-1" onClick={onScan}>
            <QrCode className="w-4 h-4" /> Check-in QR
          </Button>
        )}
        <Button variant="outline" size="sm" className="gap-1" onClick={onExport}>
          <Download className="w-4 h-4" /> Exportar
        </Button>
        {hasAccess && (
          <Button variant="outline" size="sm" className="gap-1" onClick={onImport}>
            <Upload className="w-4 h-4" /> CSV
          </Button>
        )}
        {hasAccess && (
          <Button size="sm" className="gap-1" onClick={onAdd}>
            <UserPlus className="w-4 h-4" /> Adicionar pessoa
          </Button>
        )}
      </div>
    </div>
  );
}