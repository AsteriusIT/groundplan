/**
 * The Playground's Editor view (GP-244): the files on the left, the diagram
 * they parse into on the right.
 *
 * It was the Playground page until the mode grew a second view; the panel, the
 * stack switch and the lenses are the same ones, now behind their own route so
 * a link can point at the editor rather than at "the playground, probably".
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import {
  FilePlus2,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import type { GraphNode } from "@/api/types";
import { GraphCanvas } from "@/components/graph-canvas";
import { HclEditor } from "@/components/hcl-editor";
import { IacSwitch } from "@/components/iac-switch";
import { IamTable } from "@/components/iam-table";
import {
  ViewSwitcher,
  useGraphView,
  viewsFor,
} from "@/components/view-switcher";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { errorLineOf } from "@/lib/error-line";
import { networkProjection } from "@/lib/graph-layout";
import { cn } from "@/lib/utils";

import { usePlayground } from "./playground-context";
import {
  ALLOWED_EXTENSIONS,
  fileIacType,
  NOT_IN_VIEW,
} from "./playground-files";

/** The files panel's width bounds (GP-128) — local state, never persisted. */
const PANEL_MIN_WIDTH = 260;
const PANEL_MAX_WIDTH = 640;
const PANEL_DEFAULT_WIDTH = 400;

export function PlaygroundEditorView() {
  const doc = usePlayground();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const { files, active, activePath, failure, snapshot, iacType } = doc;
  // The parse error naming the open file, if any — its line (when the message
  // carries one) is marked in the editor (GP-127).
  const activeError = active ? failure?.byFile.get(active.path) : undefined;
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

  function onUploadChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) void doc.ingestUploads(event.target.files);
    event.target.value = "";
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer?.files) void doc.ingestUploads(event.dataTransfer.files);
  }

  function commitRename(oldPath: string) {
    const next = renameValue.trim();
    setRenaming(null);
    doc.renameFile(oldPath, next);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="bg-card border-border flex items-center justify-between gap-2 border-b px-4 py-2">
        <IacSwitch
          value={iacType}
          onChange={doc.switchIacType}
          present={doc.present}
        />
        <Button
          onClick={() => void doc.visualize()}
          disabled={doc.parsing || files.length === 0}
        >
          {doc.parsing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          {doc.parsing ? "Parsing…" : "Visualize"}
        </Button>
      </div>

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
                    <DropdownMenuItem onSelect={() => doc.addFile("tf")}>
                      <FilePlus2 className="size-4" />
                      New Terraform file
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => doc.addFile("yaml")}>
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
                  doc.parsedContent !== null &&
                  doc.parsedContent.get(file.path) !== file.content;
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
                          doc.removeFile(file.path);
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
                  <li
                    key={file.path}
                    className="group flex h-6 items-center pr-2"
                  >
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
                          onClick={() => doc.setActivePath(file.path)}
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
                onChange={(content) => doc.updateContent(active.path, content)}
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
        onResize(
          clamp(drag.current.startWidth + (e.clientX - drag.current.startX)),
        );
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        onResize(
          clamp(drag.current.startWidth + (e.clientX - drag.current.startX)),
        );
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
