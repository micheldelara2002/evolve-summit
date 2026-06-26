import { Skeleton } from "@/components/ui/skeleton";

/**
 * Reusable list loading skeleton — mimics card rows.
 */
export default function ListSkeleton({ count = 4, className }) {
  return (
    <div className={className || "space-y-3"}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-4 rounded-xl border border-border bg-card">
          <Skeleton className="w-10 h-10 rounded-lg shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}