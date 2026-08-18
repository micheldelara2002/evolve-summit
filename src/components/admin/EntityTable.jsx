import { useState, useEffect } from "react";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Plus, MoreVertical, Pencil, Trash2 } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import { motion, AnimatePresence } from "framer-motion";

export default function EntityTable({
  items = [],
  columns,
  searchField = "full_name",
  onAdd,
  onEdit,
  onDelete,
  canDelete,
  addLabel,
  emptyLabel,
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [blockMsg, setBlockMsg] = useState(null);

  const filtered = items.filter((item) => {
    const val = item[searchField] || item.name || item.title || "";
    return val.toLowerCase().includes(search.toLowerCase());
  });

  useEffect(() => { setPage(1); }, [search, items]);

  const PAGE_SIZE = 20;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder={t("events.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        {onAdd && (
          <Button size="sm" onClick={onAdd} className="gap-1 shrink-0">
            <Plus className="w-4 h-4" /> {addLabel || t("common.actions")}
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <AnimatePresence>
          {paginated.map((item) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="bg-muted/40 rounded-lg p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  {columns.map((col, idx) => (
                    <div key={col.key}>
                      {idx === 0 ? (
                        <p className="font-medium text-sm truncate">{col.render ? col.render(item) : item[col.key]}</p>
                      ) : (
                        <p className="text-xs text-muted-foreground truncate">
                          {col.label}: {col.render ? col.render(item) : item[col.key] || "—"}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                      <MoreVertical className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {onEdit && (
                      <DropdownMenuItem onClick={() => onEdit(item)}>
                        <Pencil className="w-4 h-4 mr-2" /> {t("common.edit")}
                      </DropdownMenuItem>
                    )}
                    {onDelete && (
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => {
                          if (canDelete) {
                            const msg = canDelete(item);
                            if (msg) { setBlockMsg(msg); return; }
                          }
                          setDeleteTarget(item);
                        }}
                      >
                        <Trash2 className="w-4 h-4 mr-2" /> {t("common.delete")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {filtered.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-6">{emptyLabel || t("common.noData")}</p>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{filtered.length} registro(s) · pág. {page}/{totalPages}</span>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
            <Button size="sm" variant="outline" disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}>Próxima</Button>
          </div>
        </div>
      )}

      {/* Bloqueio de exclusão */}
      <AlertDialog open={!!blockMsg} onOpenChange={() => setBlockMsg(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Não é possível excluir</AlertDialogTitle>
            <AlertDialogDescription>{blockMsg}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setBlockMsg(null)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={() => setDeleteTarget(null)}
        title={t("events.confirmDelete")}
        description={deleteTarget?.full_name || deleteTarget?.name || deleteTarget?.title}
        onConfirm={() => { onDelete(deleteTarget); setDeleteTarget(null); }}
      />
    </div>
  );
}