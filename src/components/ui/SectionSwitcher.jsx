import { useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * SectionSwitcher — reusable section selector.
 * Mobile: bottom sheet. Web: dropdown with native scroll.
 *
 * Props:
 *  - sections: [{ id, label, icon? }]
 *  - activeSection: string
 *  - onSectionChange: (id) => void
 *  - className: string (applied to trigger)
 */
export default function SectionSwitcher({
  sections,
  activeSection,
  onSectionChange,
  className,
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  const activeItem = sections.find((s) => s.id === activeSection) || sections[0];

  const handleSelect = (id) => {
    onSectionChange(id);
    setOpen(false);
  };

  const renderList = () => (
    <div className="space-y-1">
      {sections.map(({ id, label, icon: Icon }) => {
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
      <PopoverContent className="w-72 p-3 max-h-[70vh] overflow-y-auto" align="start">
        {renderList()}
      </PopoverContent>
    </Popover>
  );
}