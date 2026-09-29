/**
 * Célula vazia da matriz de conquistas — clique cria uma badge na posição
 * (categoria × coluna).
 */
export default function EmptyCell({ hasAccess, onAdd }) {
  return (
    <div
      className={`rounded-xl border-2 border-dashed border-border min-h-[120px] flex items-center justify-center ${hasAccess ? "cursor-pointer hover:border-primary hover:bg-muted/20 transition-all" : ""}`}
      onClick={hasAccess ? onAdd : undefined}
    >
      {hasAccess && <span className="text-2xl text-muted-foreground/40">+</span>}
    </div>
  );
}