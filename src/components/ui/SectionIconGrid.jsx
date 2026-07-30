/**
 * Grid compacto de ícones (estilo Bradesco) para alternar entre seções.
 * Substitui o SectionSwitcher (combo) por cards quadrados com ícone + label.
 */
export default function SectionIconGrid({ sections, activeSection, onSectionChange }) {
  return (
    <div className="grid grid-cols-5 gap-2 sm:gap-2.5">
      {sections.map(({ id, label, icon: Icon }) => {
        const isActive = activeSection === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSectionChange(id)}
            className="flex flex-col items-center gap-1.5 group focus:outline-none"
          >
            <div
              className={`w-full aspect-square max-w-[64px] flex items-center justify-center rounded-2xl border shadow-sm transition-all
                ${isActive
                  ? "bg-primary border-primary shadow-md"
                  : "bg-card border-border group-hover:border-primary/40 group-hover:shadow-md"
                }`}
            >
              <Icon
                className={`w-5 h-5 ${isActive ? "text-primary-foreground" : "text-primary"}`}
                strokeWidth={1.75}
              />
            </div>
            <span
              className={`text-[10px] sm:text-[11px] font-medium text-center leading-tight line-clamp-2
                ${isActive ? "text-foreground" : "text-muted-foreground"}`}
            >
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}