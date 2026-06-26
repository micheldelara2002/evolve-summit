import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { t } from "@/lib/i18n";
import { filterEventsByAccess, isAdmin } from "@/lib/access";
import { logAudit } from "@/lib/audit";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import StatusBadge from "@/components/admin/StatusBadge";
import { Plus, Search, MoreVertical, Trash2, Pencil, Eye, ArrowLeft, Calendar } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useState } from "react";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";
import TopAppBar from "@/components/layout/TopAppBar";
import EmptyState from "@/components/ui/EmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";

export default function EventsList() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["events"],
    queryFn: () => base44.entities.Event.filter({ is_deleted: false }),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => base44.entities.Event.update(id, { is_deleted: true }),
    onSuccess: (_, id) => {
      logAudit({ event_id: id, action: "soft_delete", entity_type: "Event", entity_id: id, user });
      queryClient.invalidateQueries({ queryKey: ["events"] });
      toast.success(t("events.deleteSuccess"));
      setDeleteTarget(null);
    },
  });

  const scoped = filterEventsByAccess(events, user);
  const filtered = scoped.filter((e) =>
    e.name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <TopAppBar
        title={t("events.title")}
        onBack={() => navigate(-1)}
        actions={isAdmin(user) ? (
          <Link to="/events/new">
            <Button size="sm" className="gap-1.5">
              <Plus className="w-4 h-4" /> {t("events.create")}
            </Button>
          </Link>
        ) : undefined}
        search={
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={t("events.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        }
      />

      {isLoading && <ListSkeleton count={4} />}

      <div className="grid gap-3">
        <AnimatePresence>
          {filtered.map((event) => (
            <motion.div
              key={event.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="bg-card rounded-xl border border-border p-4 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between gap-3">
                <Link to={`/events/${event.id}`} className="flex items-center gap-3 min-w-0 flex-1">
                  {event.logo_url ? (
                    <img src={event.logo_url} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
                  ) : (
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold flex-shrink-0"
                      style={{ backgroundColor: event.color_primary || "#4F46E5" }}
                    >
                      {event.name?.[0]?.toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{event.name}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <StatusBadge status={event.status} />
                      {event.start_date && (
                        <span className="text-xs text-muted-foreground">
                          {new Date(event.start_date).toLocaleDateString("pt-BR")}
                        </span>
                      )}
                    </div>
                  </div>
                </Link>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="flex-shrink-0">
                      <MoreVertical className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => navigate(`/events/${event.id}`)}>
                      <Eye className="w-4 h-4 mr-2" /> Ver
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => navigate(`/events/${event.id}/edit`)}>
                      <Pencil className="w-4 h-4 mr-2" /> {t("common.edit")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => setDeleteTarget(event)}
                    >
                      <Trash2 className="w-4 h-4 mr-2" /> {t("common.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {!isLoading && filtered.length === 0 && (
          <EmptyState icon={Calendar} title={t("events.noEvents")} />
        )}
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("events.confirmDelete")}</AlertDialogTitle>
            <AlertDialogDescription>{deleteTarget?.name}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => deleteMut.mutate(deleteTarget.id)}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}