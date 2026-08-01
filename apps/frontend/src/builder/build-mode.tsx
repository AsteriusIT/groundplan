/**
 * Build mode (GP-133): the palette, the canvas and the selected resource's
 * form, side by side inside the playground.
 *
 * The playground owns the controller so the composition survives a trip
 * through Edit HCL; this component is what it looks like.
 */
import { resourceDef } from "@groundplan/builder";

import { BuilderCanvas } from "./builder-canvas";
import { BuilderForm } from "./builder-form";
import { BuilderPalette } from "./builder-palette";
import type { BuilderController } from "./use-builder-graph";

/** "3 resources · ready" / "2 problems to fix" — the state of the sketch. */
export function compositionStatus(
  nodeCount: number,
  issueCount: number,
): string {
  if (nodeCount === 0) return "Nothing composed yet";
  const resources = `${nodeCount} resource${nodeCount === 1 ? "" : "s"}`;
  if (issueCount === 0) return `${resources} · ready to generate`;
  return `${resources} · ${issueCount} problem${issueCount === 1 ? "" : "s"} to fix`;
}

export function BuildMode({
  builder,
  actions,
}: Readonly<{
  builder: BuilderController;
  /** The generate control (GP-135), rendered in the status bar. */
  actions?: React.ReactNode;
}>) {
  const selected = builder.graph.nodes.find((n) => n.id === builder.selectedId);
  const selectedDef = selected ? resourceDef(selected.type) : undefined;
  const selectedIssues = builder.issues.filter(
    (issue) => issue.nodeId === builder.selectedId,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <BuilderPalette onAdd={builder.addNode} />

        <div className="relative min-h-0 flex-1">
          {builder.graph.nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <p className="text-muted-foreground max-w-sm text-center text-sm">
                Pick a resource on the left to start composing. Connect
                resources to reference them, then generate the Terraform.
              </p>
            </div>
          )}
          <BuilderCanvas
            graph={builder.graph}
            issues={builder.issues}
            selectedId={builder.selectedId}
            onSelect={builder.select}
            onMove={builder.move}
            onConnect={builder.connect}
            onDisconnect={builder.disconnect}
            onDelete={builder.remove}
          />
        </div>

        {selected && selectedDef && (
          <BuilderForm
            node={selected}
            def={selectedDef}
            graph={builder.graph}
            issues={selectedIssues}
            onRename={(name) => builder.rename(selected.id, name)}
            onAttribute={(attribute, value) =>
              builder.setAttribute(selected.id, attribute, value)
            }
            onConnect={(attribute, to) =>
              builder.connect(selected.id, attribute, to)
            }
            onDisconnect={(attribute, to) =>
              builder.disconnect(selected.id, attribute, to)
            }
            onDelete={() => builder.remove(selected.id)}
          />
        )}
      </div>

      <div className="bg-card border-border flex items-center justify-between gap-4 border-t px-4 py-2">
        <p
          className="text-muted-foreground font-mono text-[11px]"
          role="status"
        >
          {compositionStatus(builder.graph.nodes.length, builder.issues.length)}
        </p>
        {actions}
      </div>
    </div>
  );
}
