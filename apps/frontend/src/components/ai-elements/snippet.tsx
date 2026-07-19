import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

/** A one-line copyable command — the "how to use this" hint (GP-143). */
export function Snippet({
  command,
  className,
}: Readonly<{ command: string; className?: string }>) {
  return (
    <div
      className={cn(
        "bg-card flex items-center gap-2 rounded-md border border-border py-1 pr-1 pl-3",
        className,
      )}
    >
      <code className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
        <span className="select-none">$ </span>
        {command}
      </code>
      <CopyButton value={command} />
    </div>
  );
}
