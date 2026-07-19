import { cn } from "@/lib/utils";

/** The "thinking" placeholder while a response has not started (GP-140). */
export function Shimmer({ className }: Readonly<{ className?: string }>) {
  return (
    <div
      role="status"
      aria-label="Generating"
      className={cn("flex animate-pulse flex-col gap-1.5", className)}
    >
      <div className="bg-accent h-3 w-3/4 rounded" />
      <div className="bg-accent h-3 w-1/2 rounded" />
    </div>
  );
}
