import { useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";

import type { Annotation } from "@/api/types";
import { Button } from "@/components/ui/button";
import { ChangeSummary } from "@/components/change-summary";
import { cn } from "@/lib/utils";

/**
 * The note editor for a selected node (GP-58), rendered in the details-panel
 * footer. Lists the node's notes with a live markdown preview (reusing the docs
 * summary renderer — no new markdown dep) and, unless read-only, lets you add,
 * edit and delete them. Writes go straight to the GP-56 API via the callbacks;
 * the parent applies them optimistically.
 */
export function NotePanel({
  notes,
  readOnly = false,
  onCreate,
  onUpdate,
  onDelete,
}: {
  notes: Annotation[];
  readOnly?: boolean;
  onCreate: (body: string) => void;
  onUpdate: (id: string, body: string) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const startEdit = (n: Annotation) => {
    setEditingId(n.id);
    setEditDraft(n.body ?? "");
  };
  const saveEdit = () => {
    if (editingId && editDraft.trim()) onUpdate(editingId, editDraft.trim());
    setEditingId(null);
  };
  const add = () => {
    if (!draft.trim()) return;
    onCreate(draft.trim());
    setDraft("");
  };

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground font-mono text-[10px] tracking-wide uppercase">
        Notes
      </p>

      {notes.length === 0 && readOnly && (
        <p className="text-faint text-xs">No notes on this resource.</p>
      )}

      <ul className="space-y-2">
        {notes.map((n) => (
          <li key={n.id} className="border-border rounded-md border px-2.5 py-2">
            {editingId === n.id ? (
              <div className="space-y-2">
                <textarea
                  aria-label="Edit note"
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  rows={3}
                  className="border-border w-full resize-y rounded-md border bg-transparent px-2 py-1.5 font-mono text-xs outline-none"
                />
                <div className="flex justify-end gap-1.5">
                  <IconButton label="Cancel" onClick={() => setEditingId(null)}>
                    <X className="size-3.5" />
                  </IconButton>
                  <IconButton label="Save note" onClick={saveEdit}>
                    <Check className="size-3.5" />
                  </IconButton>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <ChangeSummary markdown={n.body ?? ""} />
                </div>
                {!readOnly && (
                  <div className="flex shrink-0 gap-1">
                    <IconButton label="Edit note" onClick={() => startEdit(n)}>
                      <Pencil className="size-3.5" />
                    </IconButton>
                    <IconButton label="Delete note" onClick={() => onDelete(n.id)}>
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {!readOnly && (
        <div className="space-y-2">
          <textarea
            aria-label="New note"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Add a note (markdown)…"
            className="border-border placeholder:text-muted-foreground w-full resize-y rounded-md border bg-transparent px-2 py-1.5 font-mono text-xs outline-none"
          />
          {draft.trim() && (
            <div className="border-border bg-accent-soft/30 rounded-md border px-2.5 py-1.5">
              <ChangeSummary markdown={draft} />
            </div>
          )}
          <Button size="sm" onClick={add} disabled={!draft.trim()} className="w-full">
            <Plus className="size-3.5" />
            Add note
          </Button>
        </div>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "text-muted-foreground hover:bg-accent hover:text-foreground grid size-6 place-items-center rounded transition-colors",
      )}
    >
      {children}
    </button>
  );
}
