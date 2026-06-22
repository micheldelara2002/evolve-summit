import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Filter } from "lucide-react";

export default function BusinessFilters({
  period, setPeriod,
  customStart, setCustomStart,
  customEnd, setCustomEnd,
  eventFilter, setEventFilter,
  events,
  statusFilter, setStatusFilter,
  profileFilter, setProfileFilter,
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
        <Filter className="w-4 h-4" /> Filtros globais
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Period */}
        <div className="space-y-1.5">
          <Label className="text-xs">Período</Label>
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">7 dias</SelectItem>
              <SelectItem value="1m">1 mês</SelectItem>
              <SelectItem value="3m">3 meses</SelectItem>
              <SelectItem value="6m">6 meses</SelectItem>
              <SelectItem value="1y">1 ano</SelectItem>
              <SelectItem value="custom">Personalizado</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Event */}
        <div className="space-y-1.5">
          <Label className="text-xs">Evento</Label>
          <Select value={eventFilter} onValueChange={setEventFilter}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os eventos</SelectItem>
              {events.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Status */}
        <div className="space-y-1.5">
          <Label className="text-xs">Status do evento</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Ativos e encerrados</SelectItem>
              <SelectItem value="active">Ativos</SelectItem>
              <SelectItem value="finished">Encerrados</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Profile */}
        <div className="space-y-1.5">
          <Label className="text-xs">Perfil</Label>
          <Select value={profileFilter} onValueChange={setProfileFilter}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os perfis</SelectItem>
              <SelectItem value="attendee">Participante</SelectItem>
              <SelectItem value="speaker">Palestrante</SelectItem>
              <SelectItem value="team">Equipe</SelectItem>
              <SelectItem value="manager">Gerente</SelectItem>
              <SelectItem value="partner_rep">Rep. Parceiro</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Custom date range */}
      {period === "custom" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-border">
          <div className="space-y-1.5">
            <Label className="text-xs">Data inicial</Label>
            <Input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Data final</Label>
            <Input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
          </div>
        </div>
      )}
    </div>
  );
}