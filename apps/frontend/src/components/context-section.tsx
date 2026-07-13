import { useState } from "react";
import { FileText, Pencil, X } from "lucide-react";

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
  hint,
  readOnly = false,
  bare = false,
  onSave,
  onClose,
}: {
  markdown: string | null;
  title?: string;
  /** One line saying who reads this and where it shows up. */
  hint?: string;
  readOnly?: boolean;
  /** Drop the scroll box: the container already scrolls (see ContextRail). */
  bare?: boolean;
  onSave?: (markdown: string) => void;
  onClose?: () => void;
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
        <Header title={title} hint={hint} />
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
      <div className="flex items-start justify-between gap-4">
        <Header title={title} hint={hint} />
        <div className="flex shrink-0 items-center gap-3">
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
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Hide context"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>

      {hasContent ? (
        <div
          className={
            bare ? "" : "border-border max-h-64 overflow-auto rounded-md border px-3 py-2"
          }
        >
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

/**
 * The context, docked as a right rail beside a diagram canvas — the same shape
 * as the pull request's change summary. It keeps the long markdown out of the
 * page header, where it was pushing the diagram off the fold, while staying one
 * click away.
 */
export function ContextRail({
  markdown,
  onSave,
  onClose,
}: {
  markdown: string | null;
  onSave: (markdown: string) => void;
  onClose: () => void;
}) {
  return (
    <aside className="border-border bg-card w-80 shrink-0 overflow-y-auto border-l px-4 py-4">
      <ContextSection markdown={markdown} bare onSave={onSave} onClose={onClose} />
    </aside>
  );
}

function Header({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground font-mono text-[10px] tracking-[0.14em] uppercase">
        {title}
      </p>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}
