import { Ruler } from "lucide-react";

/** A quiet "not built yet" panel for placeholder routes. */
export function Placeholder({ note }: { note: string }) {
  return (
    <div className="bg-card/40 flex flex-col items-center gap-3 rounded-md border border-dashed border-border px-8 py-16 text-center">
      <div className="bg-accent text-primary grid size-12 place-items-center rounded-sm">
        <Ruler className="size-6" />
      </div>
      <p className="text-muted-foreground max-w-sm text-sm">{note}</p>
    </div>
  );
}
