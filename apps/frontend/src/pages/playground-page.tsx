import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import {
  ChevronDown,
  FilePlus2,
  FolderOpen,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Plus,
  Save,
  SaveAll,
  Trash2,
  Upload,
} from "lucide-react";

import {
  ApiError,
  deletePlaygroundDraft,
  parsePlayground,
  updatePlaygroundDraft,
} from "@/api/client";
import type {
  GraphNode,
  IacType,
  PlaygroundDraft,
  PlaygroundFile,
  PlaygroundSnapshot,
} from "@/api/types";
import { GraphCanvas } from "@/components/graph-canvas";
import { HclEditor } from "@/components/hcl-editor";
import { IacSwitch } from "@/components/iac-switch";
import { IamTable } from "@/components/iam-table";
import {
  ViewSwitcher,
  useGraphView,
  viewsFor,
} from "@/components/view-switcher";
import { networkProjection } from "@/lib/graph-layout";
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
import { errorLineOf } from "@/lib/error-line";
import { cn } from "@/lib/utils";

/** The files panel's width bounds (GP-128) — local state, never persisted. */
const PANEL_MIN_WIDTH = 260;
const PANEL_MAX_WIDTH = 640;
const PANEL_DEFAULT_WIDTH = 400;

/** Extensions the backend accepts (GP-123, widened for Kubernetes). */
const TF_EXTENSIONS = [".tf", ".tfvars"];
const K8S_EXTENSIONS = [".yaml", ".yml"];
const ALLOWED_EXTENSIONS = [...TF_EXTENSIONS, ...K8S_EXTENSIONS];

function isAllowedPath(path: string): boolean {
  return ALLOWED_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Which stack a file belongs to, by extension — the whole detection story. */
function fileIacType(path: string): IacType {
  return K8S_EXTENSIONS.some((ext) => path.endsWith(ext))
    ? "kubernetes"
    : "terraform";
}

/** The mode for a file set: the preferred side if it has files, else the other. */
function modeFor(files: PlaygroundFile[], preferred: IacType): IacType {
  const has = (t: IacType) => files.some((f) => fileIacType(f.path) === t);
  if (has(preferred)) return preferred;
  const other: IacType = preferred === "terraform" ? "kubernetes" : "terraform";
  return has(other) ? other : preferred;
}

const NOT_IN_VIEW: Record<IacType, string> = {
  terraform: "Not in the Terraform view",
  kubernetes: "Not in the Kubernetes view",
};

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
  // Which stack Visualize parses, and one snapshot slot per stack — flipping
  // the switch shows that mode's last render, never a blank canvas.
  const [iacType, setIacType] = useState<IacType>("terraform");
  const [snapshots, setSnapshots] = useState<
    Record<IacType, PlaygroundSnapshot | null>
  >({ terraform: null, kubernetes: null });
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
  // GP-129: the header centres on the draft — inline title rename and the
  // delete-current-draft confirmation.
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [deleteDraftOpen, setDeleteDraftOpen] = useState(false);

  const active = files.find((f) => f.path === activePath) ?? null;
  // The parse error naming the open file, if any — its line (when the message
  // carries one) is marked in the editor (GP-127).
  const activeError = active ? failure?.byFile.get(active.path) : undefined;
  const snapshot = snapshots[iacType];
  const present: Record<IacType, boolean> = {
    terraform: files.some((f) => fileIacType(f.path) === "terraform"),
    kubernetes: files.some((f) => fileIacType(f.path) === "kubernetes"),
  };
  // The lenses on the active snapshot: Global / Network / IAM for Terraform,
  // diagram only for Kubernetes (viewsFor states the rule; ?view= deep links
  // onto the wrong stack fall back to infra inside useGraphView).
  const kubernetes = iacType === "kubernetes";
  const { view, setView } = useGraphView(viewsFor("playground", kubernetes));
  // Network view (GP-44's projection, client-side and pure).
  const network = useMemo(
    () =>
      snapshot && view === "network" ? networkProjection(snapshot.graph) : null,
    [snapshot, view],
  );
  // GP-49's jump: an IAM row lands selected on the Global canvas.
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const viewOnCanvas = useCallback(
    (node: GraphNode) => {
      setFocusNodeId(node.id);
      setView("infra");
    },
    [setView],
  );
  const dirty = JSON.stringify(files) !== savedSerial;
  // A scratch playground is never "Saved" — it has nowhere to be saved to.
  const unsaved = !draft || dirty;

  // Mode follows the files only when the current side has none: opening a
  // manifests-only draft lands on Kubernetes; adding a manifest to a Terraform
  // playground never yanks the mode.
  useEffect(() => {
    setIacType((current) => modeFor(files, current));
  }, [files]);

  // Leaving with unsaved changes deserves a warning (GP-126).
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const runParse = useCallback(
    async (input: PlaygroundFile[], mode: IacType) => {
      setParsing(true);
      // What this Visualize saw, per file — the baseline the "modified" marker
      // compares against (GP-128). Recorded whether or not the parse succeeds:
      // the marker answers "did I change anything since I last looked?".
      setParsedContent(new Map(input.map((f) => [f.path, f.content])));
      try {
        const parsed = await parsePlayground(input, mode);
        setSnapshots((prev) => ({ ...prev, [mode]: parsed }));
        setFailure(null);
      } catch (err) {
        // The last valid render stays on the canvas — only the error changes.
        if (err instanceof ApiError) {
          setFailure({
            message: err.message,
            byFile: new Map(
              (err.fields ?? []).map((f) => [f.field, f.message]),
            ),
          });
        } else {
          setFailure({
            message: "Could not parse the files.",
            byFile: new Map(),
          });
        }
      } finally {
        setParsing(false);
      }
    },
    [],
  );

  const visualize = useCallback(
    () => runParse(files, iacType),
    [runParse, files, iacType],
  );

  /** Switching stacks never re-parses; the failure described the last parse, so it clears. */
  const switchIacType = useCallback((next: IacType) => {
    setIacType(next);
    setFailure(null);
  }, []);

  const saveCurrentDraft = useCallback(async () => {
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
  }, [draft, files]);

  /** Save, or start the Save as flow when nothing is saved yet (GP-129). */
  const save = useCallback(() => {
    if (files.length === 0) return;
    if (draft) void saveCurrentDraft();
    else setSaveOpen(true);
  }, [files.length, draft, saveCurrentDraft]);

  // Cmd/Ctrl+S saves in place — the browser's save dialog has nothing to offer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  /** Inline title rename → PUT, like renaming from the drafts list. */
  async function commitTitleRename() {
    const name = titleDraft.trim();
    setTitleEditing(false);
    if (!draft || !name || name === draft.name) return;
    try {
      await updatePlaygroundDraft(draft.id, { name });
      setDraft({ ...draft, name });
    } catch (err) {
      setSaveError(
        err instanceof ApiError ? err.message : "Could not rename the draft.",
      );
    }
  }

  /** Delete the open draft; the files stay as an unsaved playground. */
  async function confirmDeleteDraft() {
    if (!draft) return;
    try {
      await deletePlaygroundDraft(draft.id);
      setDraft(null);
      setDeleteDraftOpen(false);
    } catch (err) {
      setSaveError(
        err instanceof ApiError ? err.message : "Could not delete the draft.",
      );
      setDeleteDraftOpen(false);
    }
  }

  function startTitleRename() {
    if (!draft) return;
    setTitleDraft(draft.name);
    setTitleEditing(true);
  }

  function handleSaved(saved: PlaygroundDraft) {
    setDraft({ id: saved.id, name: saved.name });
    setSavedSerial(JSON.stringify(saved.files));
  }

  /** Restore a draft's files and redraw — an invalid draft still opens. The
   *  mode is derived from what the draft holds before the auto-parse runs. */
  function openDraft(opened: PlaygroundDraft) {
    const mode = modeFor(opened.files, iacType);
    setIacType(mode);
    setFiles(opened.files);
    setActivePath(opened.files[0]?.path ?? "");
    setDraft({ id: opened.id, name: opened.name });
    setSavedSerial(JSON.stringify(opened.files));
    setSaveError(null);
    void runParse(opened.files, mode);
  }

  function addFile(ext: "tf" | "yaml") {
    let n = 1;
    while (files.some((f) => f.path === `untitled-${n}.${ext}`)) n += 1;
    const path = `untitled-${n}.${ext}`;
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
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="text-muted-foreground font-mono text-[11px] tracking-[0.14em] uppercase">
              Playground
            </p>
            {/* Title = the draft (GP-129): its name, editable in place; a
                scratch playground is "Untitled" until it is saved as one. */}
            {titleEditing && draft ? (
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
                {draft ? (
                  <button
                    type="button"
                    title="Rename draft"
                    onClick={startTitleRename}
                    className="hover:bg-accent/60 -mx-1 truncate rounded px-1 text-left"
                  >
                    {draft.name}
                  </button>
                ) : (
                  "Untitled"
                )}
              </h1>
            )}
          </div>
          {/* The centered stack switch: which parser Visualize runs. */}
          <IacSwitch
            value={iacType}
            onChange={switchIacType}
            present={present}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* The save status lives beside the actions it points at, and is
                itself the shortest path to saving. */}
            <button
              type="button"
              aria-label={unsaved ? "Unsaved changes" : "Saved"}
              onClick={save}
              disabled={saving || files.length === 0}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 px-1 font-mono text-[11px] disabled:pointer-events-none"
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  unsaved ? "bg-update" : "bg-create",
                )}
              />
              {(() => {
                if (saving) return "Saving…";
                return unsaved ? "Unsaved changes" : "Saved";
              })()}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" aria-label="Draft actions">
                  <FolderOpen className="size-4" />
                  <span className="max-w-40 truncate">
                    {draft ? draft.name : "Drafts"}
                  </span>
                  <ChevronDown className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={saving || files.length === 0}
                  onSelect={save}
                >
                  <Save className="size-4" />
                  Save
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={files.length === 0}
                  onSelect={() => setSaveOpen(true)}
                >
                  <SaveAll className="size-4" />
                  Save as…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDraftsOpen(true)}>
                  <FolderOpen className="size-4" />
                  Open draft…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!draft} onSelect={startTitleRename}>
                  <Pencil className="size-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!draft}
                  variant="destructive"
                  onSelect={() => setDeleteDraftOpen(true)}
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
                  <DropdownMenuItem onSelect={() => addFile("tf")}>
                    <FilePlus2 className="size-4" />
                    New Terraform file
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => addFile("yaml")}>
                    <FilePlus2 className="size-4" />
                    New manifest
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
              // A file of the other stack stays listed — muted, not hidden:
              // deleting it because the switch moved would be data loss.
              const inView = fileIacType(file.path) === iacType;
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
                          !inView && "opacity-60",
                          fileError && "text-destructive",
                        )}
                        title={
                          fileError ??
                          (inView ? undefined : NOT_IN_VIEW[iacType])
                        }
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
              Add or drop <span className="font-mono">.tf</span> or{" "}
              <span className="font-mono">.yaml</span> files to begin.
            </p>
          )}

          <PanelResizeHandle width={panelWidth} onResize={setPanelWidth} />
        </aside>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          {/* The lens tabs, once there is a snapshot to look through. In
              Kubernetes mode the switcher removes itself, so no empty bar. */}
          {snapshot && !kubernetes && (
            <div className="bg-card border-border flex items-center border-b px-4 pt-2">
              <ViewSwitcher variant="playground" kubernetes={kubernetes} />
            </div>
          )}
          {/* The gridded paper is the diagram's surface — the IAM view is a
              table and sits on plain background, as on the docs page. */}
          <section
            aria-label="Diagram"
            className={cn(
              "relative min-h-0 flex-1",
              view !== "iam" && "blueprint-grid",
            )}
          >
            {(() => {
              if (!snapshot) {
                return (
                  <div className="flex h-full items-center justify-center">
                    <p className="text-muted-foreground max-w-sm text-center text-sm">
                      Edit the files on the left, then click{" "}
                      <span className="text-foreground font-medium">
                        Visualize
                      </span>{" "}
                      to draw the diagram. Nothing is saved or sent anywhere
                      else.
                    </p>
                  </div>
                );
              }
              if (view === "iam") {
                return (
                  <IamTable
                    graph={snapshot.graph}
                    variant="docs"
                    onViewInPlanImpact={viewOnCanvas}
                  />
                );
              }
              return (
                <GraphCanvas
                  // Each view keeps its own camera (GP-156).
                  key={view}
                  graph={network ? network.graph : snapshot.graph}
                  variant="docs"
                  containerIds={network?.containerIds}
                  stacks={network?.stacks}
                  chips={network?.chips}
                  focusNodeId={focusNodeId}
                />
              );
            })()}
          </section>
        </div>
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
      {/* Deleting the *open* draft (GP-129) — the files stay on screen as an
          unsaved playground; only the saved copy goes. */}
      <Dialog open={deleteDraftOpen} onOpenChange={setDeleteDraftOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display">Delete draft</DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              <span className="text-foreground font-medium">{draft?.name}</span>
              . The files stay open as an unsaved playground.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDraftOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDeleteDraft()}
            >
              Delete draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
