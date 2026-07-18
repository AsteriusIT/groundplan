import { useEffect, useState } from "react";
import type { SyntheticEvent } from "react";
import { Loader2, Pencil, Trash2 } from "lucide-react";

import {
  ApiError,
  createPlaygroundDraft,
  deletePlaygroundDraft,
  getPlaygroundDraft,
  listPlaygroundDrafts,
  updatePlaygroundDraft,
} from "@/api/client";
import type {
  PlaygroundDraft,
  PlaygroundDraftSummary,
  PlaygroundFile,
} from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/format";

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Name-and-save dialog (GP-126) — the first save of a scratch playground. */
export function SaveDraftDialog({
  open,
  onOpenChange,
  files,
  onSaved,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: PlaygroundFile[];
  onSaved: (draft: PlaygroundDraft) => void;
}>) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setName("");
      setError(null);
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: SyntheticEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const draft = await createPlaygroundDraft({ name: name.trim(), files });
      onSaved(draft);
      handleOpenChange(false);
    } catch (err) {
      setError(messageOf(err, "Could not save the draft."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display">Save as draft</DialogTitle>
          <DialogDescription>
            The files are saved as they are — a draft may even hold HCL that
            does not parse yet. The diagram is regenerated on load, never
            stored.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="playground-draft-name">Draft name</Label>
            <Input
              id="playground-draft-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Azure sketch"
              autoComplete="off"
              autoFocus
            />
          </div>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? "Saving…" : "Save draft"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The drafts list (GP-126): open, rename inline, delete with confirmation.
 * A modal sub-section of the playground page, deliberately not a route.
 */
export function DraftsDialog({
  open,
  onOpenChange,
  onOpen,
  onRenamed,
  onDeleted,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the full draft when the user opens one. */
  onOpen: (draft: PlaygroundDraft) => void;
  onRenamed: (id: string, name: string) => void;
  onDeleted: (id: string) => void;
}>) {
  const [drafts, setDrafts] = useState<PlaygroundDraftSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirming, setConfirming] = useState<PlaygroundDraftSummary | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDrafts(null);
    setError(null);
    setConfirming(null);
    setRenamingId(null);
    listPlaygroundDrafts()
      .then(setDrafts)
      .catch((err: unknown) =>
        setError(messageOf(err, "Could not load the drafts.")),
      );
  }, [open]);

  async function openDraft(id: string) {
    setBusy(true);
    setError(null);
    try {
      const draft = await getPlaygroundDraft(id);
      onOpen(draft);
      onOpenChange(false);
    } catch (err) {
      setError(messageOf(err, "Could not open the draft."));
    } finally {
      setBusy(false);
    }
  }

  async function commitRename(id: string) {
    const name = renameValue.trim();
    const current = drafts?.find((d) => d.id === id);
    setRenamingId(null);
    if (!name || !current || name === current.name) return;
    try {
      await updatePlaygroundDraft(id, { name });
      setDrafts(
        (prev) => prev?.map((d) => (d.id === id ? { ...d, name } : d)) ?? null,
      );
      onRenamed(id, name);
    } catch (err) {
      setError(messageOf(err, "Could not rename the draft."));
    }
  }

  async function confirmDelete() {
    if (!confirming) return;
    setBusy(true);
    setError(null);
    try {
      await deletePlaygroundDraft(confirming.id);
      setDrafts((prev) => prev?.filter((d) => d.id !== confirming.id) ?? null);
      onDeleted(confirming.id);
      setConfirming(null);
    } catch (err) {
      setError(messageOf(err, "Could not delete the draft."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {confirming ? (
          <>
            <DialogHeader>
              <DialogTitle className="font-display">Delete draft</DialogTitle>
              <DialogDescription>
                This permanently deletes{" "}
                <span className="text-foreground font-medium">
                  {confirming.name}
                </span>
                . This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setConfirming(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void confirmDelete()}
                disabled={busy}
              >
                {busy ? "Deleting…" : "Delete draft"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="font-display">Drafts</DialogTitle>
              <DialogDescription>
                Your saved playgrounds. Opening one restores its files and
                redraws the diagram.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            )}
            {drafts === null && !error && (
              <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </p>
            )}
            {drafts?.length === 0 && (
              <p className="text-muted-foreground text-sm">
                No drafts yet — save the current playground to create one.
              </p>
            )}
            {drafts && drafts.length > 0 && (
              <ul className="divide-border -mx-1 max-h-72 divide-y overflow-y-auto">
                {drafts.map((draft) => (
                  <li key={draft.id} className="flex items-center gap-1 px-1 py-1.5">
                    {renamingId === draft.id ? (
                      <Input
                        autoFocus
                        aria-label="New draft name"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => void commitRename(draft.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename(draft.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        className="h-8"
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => void openDraft(draft.id)}
                          disabled={busy}
                          aria-label={`Open ${draft.name}`}
                          className="hover:bg-accent/60 min-w-0 flex-1 rounded-sm px-2 py-1 text-left"
                        >
                          <span className="block truncate text-sm font-medium">
                            {draft.name}
                          </span>
                          <span className="text-muted-foreground block font-mono text-[11px]">
                            {draft.fileCount}{" "}
                            {draft.fileCount === 1 ? "file" : "files"} ·{" "}
                            {formatDate(draft.updatedAt)}
                          </span>
                        </button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={`Rename ${draft.name}`}
                          onClick={() => {
                            setRenamingId(draft.id);
                            setRenameValue(draft.name);
                          }}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={`Delete ${draft.name}`}
                          onClick={() => setConfirming(draft)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
