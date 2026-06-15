import { useState } from "react";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Plus, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [blockMsg, setBlockMsg] = useState(null);

  const filtered = items.filter((item) => {
    const val = item[searchField] || item.name || item.title || "";
    return val.toLowerCase().includes(search.toLowerCase());
  });

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
          {filtered.map((item) => (
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

      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("events.confirmDelete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.full_name || deleteTarget?.name || deleteTarget?.title}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => { onDelete(deleteTarget); setDeleteTarget(null); }}
            >
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}