/**
 * Build mode (GP-133): the palette, the canvas and the selected resource's
 * form, side by side inside the playground.
 *
 * The playground owns the controller so the composition survives a trip
 * through Edit HCL; this component is what it looks like.
 */
import { useCallback } from "react";

import { CATALOG, resourceDef, type BuilderIssue } from "@groundplan/builder";

import { BuilderCanvas } from "./builder-canvas";
import { BuilderForm } from "./builder-form";
import { CUSTOM_TYPE } from "./builder-ops";
import { BuilderPalette } from "./builder-palette";
import type { CatalogState } from "./use-catalog";
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
  catalog,
  actions,
  extraIssues = [],
}: Readonly<{
  builder: BuilderController;
  /** The catalog the picker searches and the form renders from (GP-238). */
  catalog: CatalogState;
  /** The generate control (GP-135), rendered in the status bar. */
  actions?: React.ReactNode;
  /**
   * Issues the server reported (GP-135). The client validates with the same
   * rules, so a 422 should be unreachable — when one arrives anyway it badges
   * the same nodes rather than becoming a sentence nobody can act on.
   */
  extraIssues?: readonly BuilderIssue[];
}>) {
  const issues = [...builder.issues, ...extraIssues];

  /**
   * Placing a resource is "fetch its schema, then add it" (GP-238). The curated
   * entries resolve without a network call, so the common path is unchanged;
   * anything else waits for the one schema it needs, and the palette entry
   * shows it is waiting. A type whose schema cannot be fetched is not added —
   * a card the form has nothing to say about would be worse than nothing.
   */
  const addResource = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      // The escape hatch has no schema to fetch — that is what makes it one —
      // and a curated type is already compiled in. Both are placed in this
      // tick: waiting on a promise nobody is waiting for would turn a click
      // into a frame of nothing happening.
      if (type === CUSTOM_TYPE || resourceDef(type, CATALOG)) {
        builder.addNode(type, position);
        return;
      }
      void catalog.ensure(type).then((def) => {
        if (def) builder.addNode(type, position, def);
      });
    },
    [catalog, builder],
  );
  const selected = builder.graph.nodes.find((n) => n.id === builder.selectedId);
  // A custom resource has no definition, and that is what makes it custom.
  const selectedDef =
    selected && !selected.custom
      ? resourceDef(selected.type, catalog.defs)
      : undefined;
  const selectedIssues = issues.filter(
    (issue) => issue.nodeId === builder.selectedId,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <BuilderPalette onAdd={addResource} catalog={catalog} />

        <div className="relative min-h-0 flex-1">
          {builder.graph.nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
              <p className="text-muted-foreground max-w-sm text-center text-sm">
                Drag a resource here, or click one on the left. Connect what a
                resource offers on its right to what another needs on its left,
                then generate the Terraform.
              </p>
            </div>
          )}
          <BuilderCanvas
            graph={builder.graph}
            catalog={catalog.defs}
            issues={issues}
            selectedId={builder.selectedId}
            onSelect={builder.select}
            onMove={builder.move}
            onConnect={builder.connect}
            onDisconnect={builder.disconnect}
            onDelete={builder.remove}
            onDrop={addResource}
          />
        </div>

        {selected && (selectedDef || selected.custom) && (
          <BuilderForm
            node={selected}
            def={selectedDef}
            catalog={catalog.defs}
            graph={builder.graph}
            issues={selectedIssues}
            onRename={(name) => builder.rename(selected.id, name)}
            onRetype={(type) => builder.retype(selected.id, type)}
            onAttribute={(attribute, value) =>
              builder.setAttribute(selected.id, attribute, value)
            }
            onConnect={(attribute, to) =>
              builder.connect(selected.id, attribute, to)
            }
            onDisconnect={(attribute, to) =>
              builder.disconnect(selected.id, attribute, to)
            }
            onRenameReference={(attribute, next) =>
              builder.renameReference(selected.id, attribute, next)
            }
            onSetTargetAttribute={(attribute, targetAttribute) =>
              builder.setTargetAttribute(selected.id, attribute, targetAttribute)
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
          {compositionStatus(builder.graph.nodes.length, issues.length)}
        </p>
        {actions}
      </div>
    </div>
  );
}
