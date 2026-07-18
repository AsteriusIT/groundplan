import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import {
  FilePlus2,
  FolderOpen,
  Loader2,
  Pencil,
  Play,
  Save,
  Trash2,
  Upload,
} from "lucide-react";

import { ApiError, parsePlayground, updatePlaygroundDraft } from "@/api/client";
import type {
  PlaygroundDraft,
  PlaygroundFile,
  PlaygroundSnapshot,
} from "@/api/types";
import { GraphCanvas } from "@/components/graph-canvas";
import { HclEditor } from "@/components/hcl-editor";
import {
  DraftsDialog,
  SaveDraftDialog,
} from "@/components/playground-draft-dialogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorLineOf } from "@/lib/error-line";
import { cn } from "@/lib/utils";

/** Extensions the backend accepts (GP-123); uploads are filtered to these. */
const ALLOWED_EXTENSIONS = [".tf", ".tfvars"];

function isAllowedPath(path: string): boolean {
  return ALLOWED_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * A small linked Azure stack so the page is never empty: resource group →
 * vnet → subnet → NSG, with cross-file references (network.tf reaches back
 * into main.tf), which is exactly what the playground exists to show.
 */
const EXAMPLE_FILES: PlaygroundFile[] = [
  {
    path: "main.tf",
    content: `resource "azurerm_resource_group" "demo" {
  name     = "rg-playground"
  location = "westeurope"
}

resource "azurerm_virtual_network" "demo" {
  name                = "vnet-playground"
  location            = azurerm_resource_group.demo.location
  resource_group_name = azurerm_resource_group.demo.name
  address_space       = ["10.0.0.0/16"]
}
`,
  },
  {
    path: "network.tf",
    content: `resource "azurerm_subnet" "app" {
  name                 = "snet-app"
  resource_group_name  = azurerm_resource_group.demo.name
  virtual_network_name = azurerm_virtual_network.demo.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_network_security_group" "app" {
  name                = "nsg-app"
  location            = azurerm_resource_group.demo.location
  resource_group_name = azurerm_resource_group.demo.name
}

resource "azurerm_subnet_network_security_group_association" "app" {
  subnet_id                 = azurerm_subnet.app.id
  network_security_group_id = azurerm_network_security_group.app.id
}
`,
  },
];

type ParseFailure = {
  message: string;
  /** path → message for the files the server named. */
  byFile: Map<string, string>;
};

/**
 * Playground (GP-125/GP-126): scratch HCL files in local state, parsed on
 * demand into the same canvas the docs view uses. Drafts persist the files
 * (never the snapshot — it is regenerated on load); the parse is a button,
 * never a keystroke.
 */
export function PlaygroundPage() {
  const [files, setFiles] = useState<PlaygroundFile[]>(EXAMPLE_FILES);
  const [activePath, setActivePath] = useState<string>(
    EXAMPLE_FILES[0]?.path ?? "",
  );
  const [snapshot, setSnapshot] = useState<PlaygroundSnapshot | null>(null);
  const [parsing, setParsing] = useState(false);
  const [failure, setFailure] = useState<ParseFailure | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  // Drafts (GP-126): the loaded draft, the baseline of the last save (for the
  // dirty flag), and the two dialogs.
  const [draft, setDraft] = useState<{ id: string; name: string } | null>(null);
  const [savedSerial, setSavedSerial] = useState<string>(() =>
    JSON.stringify(EXAMPLE_FILES),
  );
  const [saveOpen, setSaveOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const active = files.find((f) => f.path === activePath) ?? null;
  // The parse error naming the open file, if any — its line (when the message
  // carries one) is marked in the editor (GP-127).
  const activeError = active ? failure?.byFile.get(active.path) : undefined;
  const dirty = JSON.stringify(files) !== savedSerial;
  let saveLabel = "Save as draft…";
  if (draft) saveLabel = saving ? "Saving…" : "Save";

  // Leaving with unsaved changes deserves a warning (GP-126).
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const runParse = useCallback(async (input: PlaygroundFile[]) => {
    setParsing(true);
    try {
      setSnapshot(await parsePlayground(input));
      setFailure(null);
    } catch (err) {
      // The last valid render stays on the canvas — only the error changes.
      if (err instanceof ApiError) {
        setFailure({
          message: err.message,
          byFile: new Map((err.fields ?? []).map((f) => [f.field, f.message])),
        });
      } else {
        setFailure({ message: "Could not parse the files.", byFile: new Map() });
      }
    } finally {
      setParsing(false);
    }
  }, []);

  const visualize = useCallback(() => runParse(files), [runParse, files]);

  async function saveCurrentDraft() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updatePlaygroundDraft(draft.id, { files });
      setSavedSerial(JSON.stringify(files));
    } catch (err) {
      setSaveError(
        err instanceof ApiError ? err.message : "Could not save the draft.",
      );
    } finally {
      setSaving(false);
    }
  }

  function handleSaved(saved: PlaygroundDraft) {
    setDraft({ id: saved.id, name: saved.name });
    setSavedSerial(JSON.stringify(saved.files));
  }

  /** Restore a draft's files and redraw — an invalid draft still opens. */
  function openDraft(opened: PlaygroundDraft) {
    setFiles(opened.files);
    setActivePath(opened.files[0]?.path ?? "");
    setDraft({ id: opened.id, name: opened.name });
    setSavedSerial(JSON.stringify(opened.files));
    setSaveError(null);
    void runParse(opened.files);
  }

  function addFile() {
    let n = 1;
    while (files.some((f) => f.path === `untitled-${n}.tf`)) n += 1;
    const path = `untitled-${n}.tf`;
    setFiles((prev) => [...prev, { path, content: "" }]);
    setActivePath(path);
  }

  function removeFile(path: string) {
    setFiles((prev) => {
      const next = prev.filter((f) => f.path !== path);
      if (path === activePath) setActivePath(next[0]?.path ?? "");
      return next;
    });
  }

  function commitRename(oldPath: string) {
    const next = renameValue.trim();
    setRenaming(null);
    // An empty or colliding name is a no-op, not an error dialog.
    if (!next || next === oldPath || files.some((f) => f.path === next)) return;
    setFiles((prev) =>
      prev.map((f) => (f.path === oldPath ? { ...f, path: next } : f)),
    );
    if (activePath === oldPath) setActivePath(next);
  }

  function updateActiveContent(content: string) {
    setFiles((prev) =>
      prev.map((f) => (f.path === activePath ? { ...f, content } : f)),
    );
  }

  async function ingestUploads(list: FileList | File[]) {
    const accepted = [...list].filter((file) => isAllowedPath(file.name));
    if (accepted.length === 0) return;
    const read = await Promise.all(
      accepted.map(async (file) => ({
        path: file.name,
        content: await file.text(),
      })),
    );
    setFiles((prev) => {
      // Same name replaces; new names append — re-uploading is an update.
      const merged = [...prev];
      for (const incoming of read) {
        const at = merged.findIndex((f) => f.path === incoming.path);
        if (at === -1) merged.push(incoming);
        else merged[at] = incoming;
      }
      return merged;
    });
    const first = read[0];
    if (first) setActivePath(first.path);
  }

  function onUploadChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) void ingestUploads(event.target.files);
    event.target.value = "";
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer?.files) void ingestUploads(event.dataTransfer.files);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="bg-card border-b border-border px-8 py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="text-muted-foreground font-mono text-[11px] tracking-[0.14em] uppercase">
              Sandbox
            </p>
            <h1 className="font-display text-xl font-semibold">Playground</h1>
            <p className="text-muted-foreground flex items-center gap-1.5 font-mono text-[11px]">
              <span className="truncate">{draft ? draft.name : "Unsaved"}</span>
              {dirty && (
                <span
                  aria-label="Unsaved changes"
                  title="Unsaved changes"
                  className="bg-update inline-block size-1.5 shrink-0 rounded-full"
                />
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => setDraftsOpen(true)}>
              <FolderOpen className="size-4" />
              Drafts
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (draft) void saveCurrentDraft();
                else setSaveOpen(true);
              }}
              disabled={saving || files.length === 0}
            >
              <Save className="size-4" />
              {saveLabel}
            </Button>
            <Button
              onClick={() => void visualize()}
              disabled={parsing || files.length === 0}
            >
              {parsing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              {parsing ? "Parsing…" : "Visualize"}
            </Button>
          </div>
        </div>
        {failure && (
          <p className="text-destructive mt-2 text-sm" role="alert">
            {failure.message}
            {[...failure.byFile].map(([path, message]) => (
              <span key={path} className="block">
                <span className="font-mono">{path}</span> — {message}
              </span>
            ))}
          </p>
        )}
        {saveError && (
          <p className="text-destructive mt-2 text-sm" role="alert">
            {saveError}
          </p>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className="bg-card border-border flex w-[400px] shrink-0 flex-col border-r"
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          aria-label="Playground files"
        >
          <div className="border-border flex items-center justify-between gap-2 border-b px-4 py-2">
            <span className="text-muted-foreground font-mono text-[11px] tracking-[0.12em] uppercase">
              Files ({files.length})
            </span>
            <span className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={addFile}>
                <FilePlus2 className="size-4" />
                Add file
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => uploadRef.current?.click()}
              >
                <Upload className="size-4" />
                Upload
              </Button>
              <input
                ref={uploadRef}
                type="file"
                multiple
                accept={ALLOWED_EXTENSIONS.join(",")}
                onChange={onUploadChange}
                className="sr-only"
                aria-label="Upload files"
              />
            </span>
          </div>

          <ul className="border-border max-h-56 shrink-0 overflow-y-auto border-b py-1">
            {files.map((file) => {
              const fileError = failure?.byFile.get(file.path);
              return (
                <li key={file.path} className="group flex items-center gap-1 px-2">
                  {renaming === file.path ? (
                    <Input
                      autoFocus
                      aria-label="New name"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(file.path)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(file.path);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      className="h-7 font-mono text-xs"
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => setActivePath(file.path)}
                        className={cn(
                          "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-xs transition-colors",
                          file.path === activePath
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:bg-accent/60",
                          fileError && "text-destructive",
                        )}
                        title={fileError}
                      >
                        <span className="truncate">{file.path}</span>
                        {fileError && (
                          <span
                            className="bg-destructive size-1.5 shrink-0 rounded-full"
                            aria-label={`${file.path} has a parse error`}
                          />
                        )}
                      </button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Rename ${file.path}`}
                        onClick={() => {
                          setRenaming(file.path);
                          setRenameValue(file.path);
                        }}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Delete ${file.path}`}
                        onClick={() => removeFile(file.path)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>

          {active ? (
            <HclEditor
              key={active.path}
              value={active.content}
              onChange={updateActiveContent}
              ariaLabel="File content"
              errorLine={activeError ? errorLineOf(activeError) : null}
            />
          ) : (
            <p className="text-muted-foreground flex-1 px-4 py-6 text-center text-sm">
              Add or drop <span className="font-mono">.tf</span> files to begin.
            </p>
          )}
        </aside>

        <section
          aria-label="Diagram"
          className="blueprint-grid relative min-h-0 flex-1"
        >
          {snapshot ? (
            <GraphCanvas graph={snapshot.graph} variant="docs" />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-muted-foreground max-w-sm text-center text-sm">
                Edit the files on the left, then click{" "}
                <span className="text-foreground font-medium">Visualize</span> to
                draw the diagram. Nothing is saved or sent anywhere else.
              </p>
            </div>
          )}
        </section>
      </div>

      <SaveDraftDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        files={files}
        onSaved={handleSaved}
      />
      <DraftsDialog
        open={draftsOpen}
        onOpenChange={setDraftsOpen}
        onOpen={openDraft}
        onRenamed={(id, name) =>
          setDraft((d) => (d && d.id === id ? { ...d, name } : d))
        }
        onDeleted={(id) => setDraft((d) => (d && d.id === id ? null : d))}
      />
    </div>
  );
}
