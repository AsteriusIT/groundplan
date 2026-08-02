/**
 * The Playground mode's shell (GP-244).
 *
 * Two views live under it — the Editor and the experimental Build Editor — and
 * they are routes, not tabs in a header: each is a full standalone surface, and
 * which one you are in is a thing you can link somebody to.
 *
 * What the shell keeps is what both views share: the draft, its name, whether
 * it is saved, and the dialogs that manage it. The views bring their own
 * toolbars, because a stack switch means nothing on a composition canvas and a
 * palette means nothing beside a file tree.
 */
import { useState } from "react";
import { Outlet } from "react-router-dom";
import { ChevronDown, FolderOpen, Pencil, Save, SaveAll, Trash2 } from "lucide-react";

import { GenerateDialog } from "@/builder/generate-dialog";
import {
  DraftsDialog,
  SaveDraftDialog,
} from "@/components/playground-draft-dialogs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { PlaygroundContext } from "./playground-context";
import { usePlaygroundDocument } from "./use-playground-document";

export function PlaygroundLayout() {
  const doc = usePlaygroundDocument();
  // GP-129: the header centres on the draft — inline title rename and the
  // delete-current-draft confirmation.
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  function startTitleRename() {
    if (!doc.draft) return;
    setTitleDraft(doc.draft.name);
    setTitleEditing(true);
  }

  async function commitTitleRename() {
    const name = titleDraft.trim();
    setTitleEditing(false);
    await doc.renameDraft(name);
  }

  return (
    <PlaygroundContext value={doc}>
      <div className="flex h-full flex-col">
        <header className="bg-card border-border border-b px-8 py-3.5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-muted-foreground font-mono text-[11px] tracking-[0.14em] uppercase">
                Playground
              </p>
              {/* Title = the draft (GP-129): its name, editable in place; a
                  scratch playground is "Untitled" until it is saved as one. */}
              {titleEditing && doc.draft ? (
                <Input
                  autoFocus
                  aria-label="Rename draft"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={() => void commitTitleRename()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitTitleRename();
                    if (e.key === "Escape") setTitleEditing(false);
                  }}
                  className="font-display h-8 max-w-xs text-xl font-semibold"
                />
              ) : (
                <h1 className="font-display truncate text-xl font-semibold">
                  {doc.draft ? (
                    <button
                      type="button"
                      title="Rename draft"
                      onClick={startTitleRename}
                      className="hover:bg-accent/60 -mx-1 truncate rounded px-1 text-left"
                    >
                      {doc.draft.name}
                    </button>
                  ) : (
                    "Untitled"
                  )}
                </h1>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2">
              {/* The save status lives beside the actions it points at, and is
                  itself the shortest path to saving. */}
              <button
                type="button"
                aria-label={doc.unsaved ? "Unsaved changes" : "Saved"}
                onClick={doc.save}
                disabled={doc.saving || doc.files.length === 0}
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 px-1 font-mono text-[11px] disabled:pointer-events-none"
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    doc.unsaved ? "bg-update" : "bg-create",
                  )}
                />
                {(() => {
                  if (doc.saving) return "Saving…";
                  return doc.unsaved ? "Unsaved changes" : "Saved";
                })()}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" aria-label="Draft actions">
                    <FolderOpen className="size-4" />
                    <span className="max-w-40 truncate">
                      {doc.draft ? doc.draft.name : "Drafts"}
                    </span>
                    <ChevronDown className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={doc.saving || doc.files.length === 0}
                    onSelect={doc.save}
                  >
                    <Save className="size-4" />
                    Save
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={doc.files.length === 0}
                    onSelect={() => doc.setSaveOpen(true)}
                  >
                    <SaveAll className="size-4" />
                    Save as…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => doc.setDraftsOpen(true)}>
                    <FolderOpen className="size-4" />
                    Open draft…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!doc.draft}
                    onSelect={startTitleRename}
                  >
                    <Pencil className="size-4" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!doc.draft}
                    variant="destructive"
                    onSelect={() => doc.setDeleteDraftOpen(true)}
                  >
                    <Trash2 className="size-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {doc.failure && (
            <p className="text-destructive mt-2 text-sm" role="alert">
              {doc.failure.message}
              {[...doc.failure.byFile].map(([path, message]) => (
                <span key={path} className="block">
                  <span className="font-mono">{path}</span> — {message}
                </span>
              ))}
            </p>
          )}
          {doc.saveError && (
            <p className="text-destructive mt-2 text-sm" role="alert">
              {doc.saveError}
            </p>
          )}
          {doc.generateError && (
            <p className="text-destructive mt-2 text-sm" role="alert">
              {doc.generateError}
            </p>
          )}
          {/* GP-135: said once, where it matters — the sketch made the code, and
              the code is what counts from now on. */}
          {doc.oneWayNote && (
            <div className="bg-accent/60 text-muted-foreground mt-2 flex items-start gap-2 rounded-md px-3 py-2 text-sm">
              <p className="flex-1">
                These files are yours now. Editing them will not change what you
                composed, and the Build Editor never reads Terraform back — it is
                a starting point, not a second copy of the truth.
              </p>
              <button
                type="button"
                onClick={() => doc.setOneWayNote(false)}
                className="text-muted-foreground hover:text-foreground shrink-0 font-mono text-[11px]"
              >
                Dismiss
              </button>
            </div>
          )}
        </header>

        <Outlet />

        <GenerateDialog
          open={doc.generated !== null}
          onOpenChange={(open) => {
            // Cancel leaves the file set untouched — nothing was written yet.
            if (!open) doc.setGenerated(null);
          }}
          files={doc.generated ?? []}
          collisions={doc.collisions}
          onConfirm={doc.writeGenerated}
        />

        <SaveDraftDialog
          open={doc.saveOpen}
          onOpenChange={doc.setSaveOpen}
          files={doc.files}
          composition={doc.builder.graph}
          onSaved={doc.handleSaved}
        />
        <DraftsDialog
          open={doc.draftsOpen}
          onOpenChange={doc.setDraftsOpen}
          onOpen={doc.openDraft}
          onRenamed={(id, name) =>
            doc.setDraft((d) => (d && d.id === id ? { ...d, name } : d))
          }
          onDeleted={(id) => doc.setDraft((d) => (d && d.id === id ? null : d))}
        />
        {/* Deleting the *open* draft (GP-129) — the files stay on screen as an
            unsaved playground; only the saved copy goes. */}
        <Dialog
          open={doc.deleteDraftOpen}
          onOpenChange={doc.setDeleteDraftOpen}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-display">Delete draft</DialogTitle>
              <DialogDescription>
                This permanently deletes{" "}
                <span className="text-foreground font-medium">
                  {doc.draft?.name}
                </span>
                . The files stay open as an unsaved playground.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => doc.setDeleteDraftOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void doc.confirmDeleteDraft()}
              >
                Delete draft
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </PlaygroundContext>
  );
}
