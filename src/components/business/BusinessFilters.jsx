import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Filter, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

export default function BusinessFilters({
  period, setPeriod,
  customStart, setCustomStart,
  customEnd, setCustomEnd,
  eventFilter, setEventFilter,
  events,
  statusFilter, setStatusFilter,
  profileFilter, setProfileFilter,
}) {
  const [open, setOpen] = useState(false);

  // Count active filters for badge
  const activeCount = [
    period !== "3m",
    eventFilter !== "all",
    statusFilter !== "all",
    profileFilter !== "all",
    period === "custom" && (customStart || customEnd),
  ].filter(Boolean).length;

  const periodLabel = {
    "7d": "7 dias", "1m": "1 mês", "3m": "3 meses", "6m": "6 meses", "1y": "1 ano", custom: "Personalizado",
  }[period] || "3 meses";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 relative">
          <SlidersHorizontal className="w-4 h-4" />
          Filtros
          <span className="text-xs text-muted-foreground hidden sm:inline">· {periodLabel}</span>
          {activeCount > 0 && (
            <span className="ml-1 inline-flex items-center justify-center w-5 h-5 text-[10px] font-bold rounded-full bg-primary text-primary-foreground">
              {activeCount}
            </span>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-primary" /> Filtros globais
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
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

          {/* Event */}
          <div className="space-y-1.5 sm:col-span-2">
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

          {/* Profile */}
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Perfil do participante</Label>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-border">
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

        <DialogFooter>
          <Button onClick={() => setOpen(false)} className="w-full sm:w-auto">Aplicar filtros</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}