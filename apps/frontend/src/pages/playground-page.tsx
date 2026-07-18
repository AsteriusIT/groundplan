import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import {
  FilePlus2,
  FolderOpen,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Plus,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { errorLineOf } from "@/lib/error-line";
import { cn } from "@/lib/utils";

/** The files panel's width bounds (GP-128) — local state, never persisted. */
const PANEL_MIN_WIDTH = 260;
const PANEL_MAX_WIDTH = 640;
const PANEL_DEFAULT_WIDTH = 400;

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
  // GP-128: the file panel's chrome — delete confirmation, per-file content at
  // the last Visualize (the "modified" baseline), width and collapse. Width
  // lives in component state only, deliberately not persisted.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [parsedContent, setParsedContent] = useState<Map<
    string,
    string
  > | null>(null);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState(false);
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
    // What this Visualize saw, per file — the baseline the "modified" marker
    // compares against (GP-128). Recorded whether or not the parse succeeds:
    // the marker answers "did I change anything since I last looked?".
    setParsedContent(new Map(input.map((f) => [f.path, f.content])));
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
        {collapsed && (
          <div className="bg-card border-border flex w-10 shrink-0 flex-col items-center border-r py-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Expand files panel"
              title="Expand files panel"
              onClick={() => setCollapsed(false)}
            >
              <PanelLeftOpen className="size-4" />
            </Button>
          </div>
        )}
        {!collapsed && (
        <aside
          className="bg-card border-border relative flex shrink-0 flex-col border-r"
          style={{ width: panelWidth }}
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          aria-label="Playground files"
        >
          <div className="border-border flex items-center justify-between gap-2 border-b px-4 py-1.5">
            <span className="text-muted-foreground font-mono text-[11px] tracking-[0.12em] uppercase">
              Files ({files.length})
            </span>
            <span className="flex items-center gap-0.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Add or upload files"
                    title="Add or upload files"
                  >
                    <Plus className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={addFile}>
                    <FilePlus2 className="size-4" />
                    New file
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => uploadRef.current?.click()}
                  >
                    <Upload className="size-4" />
                    Upload…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Collapse files panel"
                title="Collapse files panel"
                onClick={() => setCollapsed(true)}
              >
                <PanelLeftClose className="size-4" />
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

          {/* Compact rows, auto height to ~40% of the panel: a dozen files are
              a dozen visible lines, and the editor keeps the rest (GP-128). */}
          <ul className="border-border max-h-[40%] shrink-0 overflow-y-auto border-b py-1">
            {files.map((file) => {
              const fileError = failure?.byFile.get(file.path);
              const modified =
                parsedContent !== null &&
                parsedContent.get(file.path) !== file.content;
              if (confirmingDelete === file.path) {
                return (
                  <li
                    key={file.path}
                    className="flex h-6 items-center gap-2 px-4 text-xs"
                  >
                    <span className="text-muted-foreground min-w-0 flex-1 truncate">
                      Delete <span className="font-mono">{file.path}</span>?
                    </span>
                    <button
                      type="button"
                      aria-label={`Confirm delete ${file.path}`}
                      onClick={() => {
                        removeFile(file.path);
                        setConfirmingDelete(null);
                      }}
                      className="text-destructive text-xs font-medium"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      aria-label="Cancel delete"
                      onClick={() => setConfirmingDelete(null)}
                      className="text-muted-foreground hover:text-foreground text-xs"
                    >
                      Cancel
                    </button>
                  </li>
                );
              }
              return (
                <li key={file.path} className="group flex h-6 items-center pr-2">
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
                      className="mx-2 h-6 font-mono text-xs"
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => setActivePath(file.path)}
                        aria-current={
                          file.path === activePath ? "true" : undefined
                        }
                        className={cn(
                          "flex h-full min-w-0 flex-1 items-center gap-2 border-l-2 pr-1 pl-3 text-left font-mono text-xs transition-colors",
                          file.path === activePath
                            ? "border-primary bg-accent text-foreground font-medium"
                            : "text-muted-foreground hover:bg-accent/60 border-transparent",
                          fileError && "text-destructive",
                        )}
                        title={fileError}
                      >
                        <span className="truncate">{file.path}</span>
                      </button>
                      {/* Status dots live beside the button, not inside it —
                          an aria-label inside would leak into its name. */}
                      {fileError && (
                        <span
                          className="bg-destructive size-1.5 shrink-0 rounded-full"
                          aria-label={`${file.path} has a parse error`}
                          title={fileError}
                        />
                      )}
                      {modified && (
                        <span
                          className="bg-update size-1.5 shrink-0 rounded-full"
                          aria-label={`${file.path} modified since last Visualize`}
                          title="Modified since last Visualize"
                        />
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Rename ${file.path}`}
                        onClick={() => {
                          setRenaming(file.path);
                          setRenameValue(file.path);
                        }}
                      >
                        <Pencil className="size-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Delete ${file.path}`}
                        onClick={() => setConfirmingDelete(file.path)}
                      >
                        <Trash2 className="size-3" />
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

          <PanelResizeHandle width={panelWidth} onResize={setPanelWidth} />
        </aside>
        )}

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

/**
 * The files panel's right-edge grip (GP-128), after the detail panel's
 * (GP-121) — pointer drag with capture, arrow keys nudge by 16px. The panel
 * sits on the left, so right grows and left shrinks.
 */
function PanelResizeHandle({
  width,
  onResize,
}: Readonly<{
  width: number;
  onResize: (width: number) => void;
}>) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const clamp = (w: number) =>
    Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, w));

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize files panel"
      aria-valuenow={width}
      aria-valuemin={PANEL_MIN_WIDTH}
      aria-valuemax={PANEL_MAX_WIDTH}
      tabIndex={0}
      className="hover:bg-primary/40 focus-visible:bg-primary/60 absolute inset-y-0 -right-0.5 z-10 w-1 cursor-col-resize transition-colors outline-none"
      onPointerDown={(e) => {
        drag.current = { startX: e.clientX, startWidth: width };
        // jsdom has no pointer capture; in browsers it routes the drag here.
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        onResize(clamp(drag.current.startWidth + (e.clientX - drag.current.startX)));
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        onResize(clamp(drag.current.startWidth + (e.clientX - drag.current.startX)));
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onResize(clamp(width + 16));
        if (e.key === "ArrowLeft") onResize(clamp(width - 16));
      }}
    />
  );
}
