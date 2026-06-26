import { useState, useMemo } from "react";
import { ChevronDown, Check, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { useIsMobile } from "@/hooks/use-mobile";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * SectionSwitcher — seletor de seção reutilizável (Protótipo 1).
 * Mobile: abre em bottom sheet. Web: abre em dropdown.
 *
 * Props:
 *  - sections: [{ id, label, icon? }]
 *  - activeSection: string
 *  - onSectionChange: (id) => void
 *  - searchable: boolean (auto quando > 6 seções)
 *  - className: string (aplicada ao trigger)
 */
export default function SectionSwitcher({
  sections,
  activeSection,
  onSectionChange,
  searchable,
  className,
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const activeItem = sections.find((s) => s.id === activeSection) || sections[0];
  const showSearch = searchable ?? sections.length > 6;

  const filtered = useMemo(() => {
    if (!search.trim()) return sections;
    const q = search.toLowerCase();
    return sections.filter((s) =>
      (s.label || s.id).toLowerCase().includes(q)
    );
  }, [sections, search]);

  const handleSelect = (id) => {
    onSectionChange(id);
    setOpen(false);
    setSearch("");
  };

  const renderList = () => (
    <div className="space-y-1">
      {showSearch && (
        <div className="relative mb-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder={t("sectionSwitcher.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
            autoFocus={isMobile}
          />
        </div>
      )}
      {filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">
          {t("common.noData")}
        </p>
      )}
      {filtered.map(({ id, label, icon: Icon }) => {
        const active = id === activeSection;
        return (
          <button
            key={id}
            type="button"
            onClick={() => handleSelect(id)}
            className={cn(
              "flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left min-h-[44px]",
              active
                ? "bg-primary/10 text-primary"
                : "text-foreground hover:bg-muted"
            )}
            aria-current={active ? "true" : undefined}
          >
            {Icon && <Icon className="w-4 h-4 shrink-0" />}
            <span className="flex-1 truncate">{label || id}</span>
            {active && <Check className="w-4 h-4 shrink-0 text-primary" />}
          </button>
        );
      })}
    </div>
  );

  const triggerLabel = activeItem?.label || activeItem?.id || t("sectionSwitcher.label");

  const TriggerButton = (
    <Button
      variant="outline"
      type="button"
      role="combobox"
      aria-expanded={open}
      aria-label={t("sectionSwitcher.ariaLabel")}
      className={cn("justify-between w-full sm:w-auto min-h-[44px]", className)}
    >
      <span className="flex items-center gap-2 truncate">
        {activeItem?.icon && <activeItem.icon className="w-4 h-4 shrink-0" />}
        <span className="text-muted-foreground text-xs font-medium hidden sm:inline">
          {t("sectionSwitcher.label")}:
        </span>
        <span className="font-medium truncate">{triggerLabel}</span>
      </span>
      <ChevronDown className="w-4 h-4 shrink-0 opacity-50" />
    </Button>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{TriggerButton}</SheetTrigger>
        <SheetContent side="bottom" className="rounded-t-2xl p-0">
          <SheetHeader className="px-4 pt-4 pb-2 text-left">
            <SheetTitle className="text-base font-display">
              {t("sectionSwitcher.title")}
            </SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6 max-h-[70vh] overflow-y-auto">
            {renderList()}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{TriggerButton}</PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        {renderList()}
      </PopoverContent>
    </Popover>
  );
}