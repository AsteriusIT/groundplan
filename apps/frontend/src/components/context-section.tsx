import { useState } from "react";
import { FileText, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChangeSummary } from "@/components/change-summary";

/**
 * The long-form markdown "context" block for a project or repository (GP-60):
 * a collapsed rendered preview with an Edit button that swaps in a plain
 * textarea + live markdown preview (reusing the docs summary renderer — no
 * WYSIWYG, no new markdown dep). Read-only on the public share view. Editable
 * views show an inviting empty state instead of lorem ipsum.
 */
export function ContextSection({
  markdown,
  title = "Context",
  readOnly = false,
  onSave,
}: {
  markdown: string | null;
  title?: string;
  readOnly?: boolean;
  onSave?: (markdown: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const value = markdown ?? "";
  const hasContent = value.trim().length > 0;

  // Nothing to show and no way to add it → render nothing (e.g. share view).
  if (!hasContent && readOnly) return null;

  const startEdit = () => {
    setDraft(value);
    setEditing(true);
  };
  const save = () => {
    onSave?.(draft.trim());
    setEditing(false);
  };

  if (editing) {
    return (
      <section className="space-y-2">
        <Header title={title} />
        <textarea
          aria-label="Context (markdown)"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          rows={8}
          placeholder="Describe this infrastructure — what it is, its domains, its conventions…"
          className="border-border placeholder:text-muted-foreground w-full resize-y rounded-md border bg-transparent px-3 py-2 font-mono text-xs outline-none"
        />
        {draft.trim() && (
          <div className="border-border bg-accent-soft/30 rounded-md border px-3 py-2">
            <ChangeSummary markdown={draft} />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            Save
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <Header title={title} />
        {!readOnly && hasContent && (
          <button
            type="button"
            onClick={startEdit}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
          >
            <Pencil className="size-3.5" />
            Edit context
          </button>
        )}
      </div>

      {hasContent ? (
        <div className="border-border max-h-64 overflow-auto rounded-md border px-3 py-2">
          <ChangeSummary markdown={value} />
        </div>
      ) : (
        <button
          type="button"
          onClick={startEdit}
          className="border-border text-muted-foreground hover:border-primary hover:text-foreground flex w-full items-center gap-2 rounded-md border border-dashed px-3 py-4 text-left text-sm transition-colors"
        >
          <FileText className="size-4 shrink-0" />
          Describe this infrastructure — what it is, its domains, its conventions.
        </button>
      )}
    </section>
  );
}

function Header({ title }: { title: string }) {
  return (
    <p className="text-muted-foreground font-mono text-[10px] tracking-[0.14em] uppercase">
      {title}
    </p>
  );
}
