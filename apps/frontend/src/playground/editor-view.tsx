/**
 * The Playground's Editor view (GP-245): a real editing environment on the
 * left — file tree, open-file tabs, CodeMirror — and the diagram they parse
 * into on the right, redrawn a beat after you stop typing.
 *
 * The two panes are separated by a divider you can drag, because which of the
 * two matters more changes every few minutes.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import {
  Columns2,
  FilePlus2,
  FolderPlus,
  Loader2,
  Play,
  Plus,
  SquareCode,
  Upload,
  Workflow,
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
import { errorLineOf } from "@/lib/error-line";
import { networkProjection } from "@/lib/graph-layout";
import { cn } from "@/lib/utils";

import { EditorTabs } from "./editor-tabs";
import {
  clampSplit,
  SPLIT_MAX,
  SPLIT_MIN,
  useEditorLayout,
  type EditorLayout,
} from "./editor-layout";
import { FileTreePanel } from "./file-tree-panel";
import { usePlayground } from "./playground-context";
import { ALLOWED_EXTENSIONS } from "./playground-files";

export function PlaygroundEditorView() {
  const doc = usePlayground();
  const uploadRef = useRef<HTMLInputElement>(null);
  const { layout, setLayout, split, setSplit } = useEditorLayout();
  // Where the diagram sent us (GP-245): the line of the selected node's block,
  // in the file it was declared in.
  const [located, setLocated] = useState<{ path: string; line: number } | null>(
    null,
  );

  const { files, active, failure, snapshot, iacType } = doc;
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

  /**
   * A node on the diagram is a block in a file (v8's `source`): selecting one
   * opens that file and puts the cursor on it. A node the producer recorded no
   * source for — a module, a Kubernetes object — simply does not navigate.
   */
  const openNodeSource = useCallback(
    (node: GraphNode | null) => {
      if (!node?.source) return;
      const { file, start_line } = node.source;
      if (!doc.files.some((f) => f.path === file)) return;
      doc.setActivePath(file);
      setLocated({ path: file, line: start_line });
    },
    [doc],
  );

  function onUploadChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) void doc.ingestUploads(event.target.files);
    event.target.value = "";
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer?.files) {
      void doc.ingestUploads(event.dataTransfer.files);
    }
  }

  const editorPane = (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside
        className="bg-card border-border flex w-60 shrink-0 flex-col border-r"
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
        aria-label="Playground files"
      >
        <div className="border-border flex items-center justify-between gap-2 border-b px-4 py-1.5">
          <span className="text-muted-foreground font-mono text-[11px] tracking-[0.12em] uppercase">
            Files ({files.length})
          </span>
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
              <DropdownMenuItem onSelect={() => doc.addFolder("new-folder")}>
                <FolderPlus className="size-4" />
                New folder
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => uploadRef.current?.click()}>
                <Upload className="size-4" />
                Upload…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={uploadRef}
            type="file"
            multiple
            accept={ALLOWED_EXTENSIONS.join(",")}
            onChange={onUploadChange}
            className="sr-only"
            aria-label="Upload files"
          />
        </div>
        <FileTreePanel />
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <EditorTabs />
        {active ? (
          <HclEditor
            docId={active.path}
            value={active.content}
            onChange={(content) => doc.updateContent(active.path, content)}
            ariaLabel="File content"
            errorLine={activeError ? errorLineOf(activeError) : null}
            locatedLine={
              located && located.path === active.path ? located.line : null
            }
          />
        ) : (
          <p className="text-muted-foreground flex-1 px-4 py-6 text-center text-sm">
            Add or drop <span className="font-mono">.tf</span> or{" "}
            <span className="font-mono">.yaml</span> files to begin.
          </p>
        )}
      </div>
    </div>
  );

  const previewPane = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                  Edit the files on the left and the diagram draws itself a
                  moment later. Nothing is saved or sent anywhere else.
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
              onNodeSelect={openNodeSource}
            />
          );
        })()}
      </section>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="bg-card border-border flex items-center justify-between gap-2 border-b px-4 py-2">
        <IacSwitch
          value={iacType}
          onChange={doc.switchIacType}
          present={doc.present}
        />
        <LayoutToggle value={layout} onChange={setLayout} />
        <Button
          variant="outline"
          onClick={() => void doc.visualize()}
          disabled={doc.parsing || files.length === 0}
          title="Redraw now, without waiting for the pause"
        >
          {doc.parsing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          {doc.parsing ? "Parsing…" : "Visualize"}
        </Button>
      </div>

      {/* Both panes stay mounted whatever the layout is: hiding the editor
          must not cost the open tabs, the cursors or an unsaved edit, and
          hiding the diagram must not cost the camera. `hidden` takes them out
          of the accessibility tree without taking them out of React. */}
      <div className="flex min-h-0 flex-1">
        <div
          className={cn("flex min-h-0 min-w-0", layout === "editor" && "flex-1")}
          style={layout === "split" ? { width: `${split}%` } : undefined}
          hidden={layout === "preview"}
        >
          {editorPane}
        </div>
        {layout === "split" && <SplitHandle value={split} onChange={setSplit} />}
        <div
          className="flex min-h-0 min-w-0 flex-1"
          hidden={layout === "editor"}
        >
          {previewPane}
        </div>
      </div>
    </div>
  );
}

/**
 * The divider between the editor and the diagram — the files panel's grip
 * (GP-128) applied to the split itself, in percent so the ratio survives a
 * window resize.
 */
function SplitHandle({
  value,
  onChange,
}: Readonly<{ value: number; onChange: (percent: number) => void }>) {
  const drag = useRef<{ startX: number; startValue: number; width: number } | null>(
    null,
  );

  const clamp = clampSplit;

  const moved = (clientX: number) => {
    if (!drag.current) return value;
    const { startX, startValue, width } = drag.current;
    return clamp(startValue + ((clientX - startX) / width) * 100);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize editor"
      aria-valuenow={value}
      aria-valuemin={SPLIT_MIN}
      aria-valuemax={SPLIT_MAX}
      tabIndex={0}
      className="hover:bg-primary/40 focus-visible:bg-primary/60 border-border w-1 shrink-0 cursor-col-resize border-l transition-colors outline-none"
      onPointerDown={(e) => {
        drag.current = {
          startX: e.clientX,
          startValue: value,
          // The pane's parent is what 100% means; in jsdom it is 0, and a drag
          // there is not a thing anyway.
          width: e.currentTarget.parentElement?.clientWidth || window.innerWidth,
        };
        // jsdom has no pointer capture; in browsers it routes the drag here.
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current) onChange(moved(e.clientX));
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        onChange(moved(e.clientX));
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onChange(clamp(value + 5));
        if (e.key === "ArrowLeft") onChange(clamp(value - 5));
      }}
    />
  );
}

/**
 * All editor / both / all diagram (GP-246). Three states, one control, in the
 * toolbar of the view it lays out — and the same three the keyboard cycles.
 */
const LAYOUTS: readonly {
  id: EditorLayout;
  label: string;
  icon: typeof Columns2;
}[] = [
  { id: "editor", label: "Editor", icon: SquareCode },
  { id: "split", label: "Split", icon: Columns2 },
  { id: "preview", label: "Preview", icon: Workflow },
];

function LayoutToggle({
  value,
  onChange,
}: Readonly<{
  value: EditorLayout;
  onChange: (layout: EditorLayout) => void;
}>) {
  return (
    <fieldset
      aria-label="Editor layout"
      className="border-border bg-background flex items-center gap-0.5 rounded-lg border p-0.5"
    >
      {LAYOUTS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          title={`${label} (Ctrl+Alt+L cycles)`}
          onClick={() => onChange(id)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === id
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
    </fieldset>
  );
}
