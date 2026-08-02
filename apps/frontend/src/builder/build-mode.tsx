/**
 * Build mode (GP-133): the palette, the canvas and the selected resource's
 * form, side by side inside the playground.
 *
 * The playground owns the controller so the composition survives a trip
 * through Edit HCL; this component is what it looks like.
 */
import { useCallback, useEffect, useState } from "react";

import {
  CATALOG,
  defFor,
  isVariable,
  resourceDef,
  schemaKindOf,
  type BuilderIssue,
  type BuilderMode,
} from "@groundplan/builder";

import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { BuilderCanvas } from "./builder-canvas";
import { BuilderForm } from "./builder-form";
import { CUSTOM_TYPE, VARIABLE_TYPE } from "./builder-ops";
import { BuilderPalette } from "./builder-palette";
import type { CatalogState } from "./use-catalog";
import type { BuilderController } from "./use-builder-graph";

/**
 * "3 resources · ready" / "2 resources · 1 variable · 2 problems to fix" — the
 * state of the sketch. Variables are counted apart because they are not
 * resources: nothing is created for one, and calling three inputs "three
 * resources" would be the status line telling its first lie (GP-249).
 */
export function compositionStatus(
  nodes: readonly { mode?: BuilderMode }[],
  issueCount: number,
): string {
  if (nodes.length === 0) return "Nothing composed yet";
  const variables = nodes.filter(isVariable).length;
  const resources = nodes.length - variables;
  const counted = [
    ...(resources > 0 ? [`${resources} resource${resources === 1 ? "" : "s"}`] : []),
    ...(variables > 0 ? [`${variables} variable${variables === 1 ? "" : "s"}`] : []),
  ].join(" · ");
  if (issueCount === 0) return `${counted} · ready to generate`;
  return `${counted} · ${issueCount} problem${issueCount === 1 ? "" : "s"} to fix`;
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
    (type: string, position?: { x: number; y: number }, parentId?: string) => {
      // The escape hatch has no schema to fetch — that is what makes it one —
      // and a curated type is already compiled in. Both are placed in this
      // tick: waiting on a promise nobody is waiting for would turn a click
      // into a frame of nothing happening.
      if (
        type === CUSTOM_TYPE ||
        type === VARIABLE_TYPE ||
        resourceDef(type, CATALOG)
      ) {
        builder.addNode(type, position, undefined, parentId);
        return;
      }
      void catalog.ensure(type).then((def) => {
        if (def) builder.addNode(type, position, def, parentId);
      });
    },
    [catalog, builder],
  );

  /**
   * Everything on the canvas needs the definition that describes it, and a
   * composition does not always arrive one node at a time: a draft reopens with
   * whatever was in it, including types nobody searched for this session and
   * lookups whose data source has never been read (GP-248). Anything the
   * catalog cannot describe yet is fetched here — `ensure` caches and
   * de-duplicates, so this settles in one pass and then does nothing.
   */
  const { defs, ensure } = catalog;
  useEffect(() => {
    for (const node of builder.graph.nodes) {
      if (node.custom || node.type.trim() === "") continue;
      if (defFor(node, defs)) continue;
      void ensure(node.type, schemaKindOf(node));
    }
  }, [builder.graph.nodes, defs, ensure]);

  /**
   * Declaring a resource and looking one up are two different schemas, so the
   * switch is "read the other schema, then change the node" — the same shape as
   * placing one. A type with no data source cannot be looked up at all, and the
   * form says so instead of pretending the click did something.
   */
  const [modeError, setModeError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const setMode = useCallback(
    (id: string, type: string, mode: BuilderMode) => {
      setModeError(null);
      setSwitching(true);
      void catalog
        .ensure(type, mode === "data" ? "data_source" : "resource")
        .then((def) => {
          if (def) builder.setMode(id, mode, def);
          else if (mode === "data") {
            setModeError(
              `The catalog has no data source for ${type}. It can only be declared here.`,
            );
          } else {
            setModeError(`The catalog has no schema for ${type}.`);
          }
        })
        .finally(() => setSwitching(false));
    },
    [catalog, builder],
  );

  /**
   * Deleting a container is two intentions (GP-247), and neither is safe to
   * assume: take the branch, or keep what is inside it. A leaf has no such
   * question, so it goes without one.
   */
  const [deleting, setDeleting] = useState<string | null>(null);
  const remove = useCallback(
    (id: string) => {
      if (builder.childrenOf(id).length > 0) setDeleting(id);
      else builder.remove(id);
    },
    [builder],
  );
  const deletingNode = builder.graph.nodes.find((n) => n.id === deleting);
  const selected = builder.graph.nodes.find((n) => n.id === builder.selectedId);
  // A custom resource has no definition, and that is what makes it custom.
  const selectedDef =
    selected && !selected.custom ? defFor(selected, catalog.defs) : undefined;
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
                Drag a resource here, or click one on the left. Put resources
                inside a resource group, a network inside that, subnets inside
                the network — what contains what is the whole design — then
                generate the Terraform.
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
            onNest={builder.nest}
            onDelete={remove}
            onDrop={addResource}
          />
        </div>

        {selected && (selectedDef || selected.custom) && (
          <BuilderForm
            key={selected.id}
            node={selected}
            def={selectedDef}
            catalog={catalog.defs}
            graph={builder.graph}
            issues={selectedIssues}
            {...(selected.mode === "variable"
              ? {}
              : {
                  onSetMode: (mode: BuilderMode) =>
                    setMode(selected.id, selected.type, mode),
                  modeBusy: switching,
                  modeError,
                })}
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
            onDelete={() => remove(selected.id)}
          />
        )}
      </div>

      {/* Deleting a container (GP-247): the children are the question, and
          the answer is the user's. Cancel is the third answer. */}
      <Dialog
        open={deletingNode !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display">
              Delete {deletingNode?.name}
            </DialogTitle>
            <DialogDescription>
              {builder.childrenOf(deletingNode?.id ?? "").length} resource
              {builder.childrenOf(deletingNode?.id ?? "").length === 1
                ? " is"
                : "s are"}{" "}
              drawn inside it. Delete them too, or keep them where it was?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (deletingNode) builder.removeBranch(deletingNode.id, "promote");
                setDeleting(null);
              }}
            >
              Keep them
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deletingNode) builder.removeBranch(deletingNode.id, "delete");
                setDeleting(null);
              }}
            >
              Delete everything inside
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="bg-card border-border flex items-center justify-between gap-4 border-t px-4 py-2">
        <div className="flex items-center gap-2">
          {/* Said where the work happens, not only where it is chosen. */}
          <Chip variant="accent" className="text-[9px]">
            Experimental
          </Chip>
          <p
            className="text-muted-foreground font-mono text-[11px]"
            role="status"
          >
            {compositionStatus(builder.graph.nodes, issues.length)}
          </p>
        </div>
        {actions}
      </div>
    </div>
  );
}
