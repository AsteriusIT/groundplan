/**
 * The builder's canvas (GP-133, containment in GP-247) — a React Flow editor,
 * deliberately not the read-only `@groundplan/canvas` one. Creating, nesting and
 * deleting is a different job from rendering a snapshot, and that canvas is also
 * the VS Code webview's.
 *
 * Hierarchy can be drawn as **space**: a subnet inside a virtual network inside
 * a resource group. Dropping a node into a frame fills the reference slot that
 * takes that frame's type (see `builder-ops.reparent`), so nesting and wiring
 * are two ways of saying one thing rather than two models.
 *
 * Both ways stay open. Dragging a wire from what a resource offers to what
 * another needs is how this canvas has always worked, and a connection that
 * containment could express also nests the node — the frame moving is the
 * confirmation the connection was made.
 *
 * Positions live in React Flow while a node is being dragged and land in the
 * document when the drag ends. Feeding every frame back through the document
 * made the card flicker: the canvas moved it, the re-render put it back where
 * the document still said it was, and the next frame moved it again.
 *
 * No layout engine either: positions are the user's, and an ELK pass that moved
 * a card somebody placed would be the tool arguing with its user.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type IsValidConnection,
  type NodeChange,
} from "@xyflow/react";

import {
  addressOf,
  ancestorsOf,
  attributeKey,
  CATALOG,
  defFor,
  issuesByNode,
  type BuilderGraph,
  type BuilderIssue,
  type BuilderNode,
  type ResourceDef,
} from "@groundplan/builder";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  BuilderContainerNode,
  type BuilderContainerFlowNode,
} from "./builder-container-node";
import {
  absoluteBoxes,
  byDepth,
  cardWidth,
  containerAt,
  CONTAINER_HEADER,
  CONTAINER_PADDING,
  drawsAsContainer,
  inputsOf,
  nodeAt,
  relativePosition,
} from "./builder-layout";
import { canAttach } from "./builder-ops";
import {
  BuilderResourceNode,
  NEW_REFERENCE_HANDLE,
  type BuilderFlowNode,
} from "./builder-node";

import "@xyflow/react/dist/style.css";

const nodeTypes = { builder: BuilderResourceNode, container: BuilderContainerNode };

type FlowNode = BuilderFlowNode | BuilderContainerFlowNode;

/** The drag-and-drop payload: which catalog type is being dropped. */
export const PALETTE_MIME = "application/x-groundplan-resource";

/**
 * Frames below, cards above. React Flow raises a child one step above its own
 * parent, which leaves the case that actually goes wrong: a card and a frame
 * that overlap without being related, where whichever was built last wins and
 * a resource disappears behind a box it has nothing to do with. A hundred is
 * simply more nesting than a composition will ever have.
 */
const FRAME_Z = 0;
const CARD_Z = 100;
/**
 * …and the one in your hand above its own kind. Selection is what a drag
 * begins with, so this is the card being moved: it has to stay visible while
 * it crosses another, without ever climbing over the frames.
 */
const HELD = 1;

export type BuilderCanvasProps = {
  graph: BuilderGraph;
  /** What the canvas draws slots and nesting rules from (GP-238). */
  catalog?: readonly ResourceDef[];
  issues: readonly BuilderIssue[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, position: { x: number; y: number }) => void;
  onConnect: (from: string, attribute: string, to: string) => void;
  onDisconnect: (from: string, attribute: string, to: string) => void;
  /** Draw a node inside a container, or (no parent) back onto the canvas. */
  onNest: (id: string, parentId: string | undefined) => void;
  onDelete: (id: string) => void;
  /** A palette entry dropped on the canvas, in whatever it was dropped into. */
  onDrop: (
    type: string,
    position: { x: number; y: number },
    parentId?: string,
  ) => void;
};

/** `from|attribute|to` — an edge id that says exactly which slot it fills. */
function edgeId(from: string, attribute: string, to: string): string {
  return `${from}|${attribute}|${to}`;
}

/** One thing a dropped wire could be attached to, on the node it landed on. */
export type Bindable = { attribute: string; label: string; required: boolean };

/**
 * Everything on `target` that `source` may be attached to (GP-250): its typed
 * slots, and — since an argument can point at a variable rather than hold a
 * literal (GP-249) — its ordinary arguments too. `canAttach` decides each one,
 * so this list is exactly what the form would offer and what a wire onto a
 * handle would be allowed to do.
 */
export function bindableOn(
  graph: BuilderGraph,
  target: BuilderNode,
  sourceId: string,
  catalog: readonly ResourceDef[] = CATALOG,
): Bindable[] {
  const def = defFor(target, catalog);
  if (!def) return [];
  return [
    ...def.attributes.map((a) => ({
      attribute: attributeKey(a),
      label: a.label,
      required: a.required,
    })),
    ...def.references.map((slot) => ({
      attribute: slot.attribute,
      label: slot.label,
      required: slot.required,
    })),
  ]
    .filter((row) => canAttach(graph, target.id, row.attribute, sourceId, catalog))
    .sort((a, b) => Number(b.required) - Number(a.required));
}

/** Where the pointer is, mouse or finger — React Flow hands over either. */
function pointerOf(event: MouseEvent | TouchEvent): { x: number; y: number } {
  if ("clientX" in event) return { x: event.clientX, y: event.clientY };
  const touch = event.changedTouches[0] ?? event.touches[0];
  return { x: touch?.clientX ?? 0, y: touch?.clientY ?? 0 };
}

function Canvas({
  graph,
  catalog = CATALOG,
  issues,
  selectedId,
  onSelect,
  onMove,
  onConnect,
  onDisconnect,
  onNest,
  onDelete,
  onDrop,
}: Readonly<BuilderCanvasProps>) {
  const byNode = useMemo(() => issuesByNode(issues), [issues]);
  const { screenToFlowPosition } = useReactFlow();
  const [flowNodes, setFlowNodes, onNodesChangeInternal] =
    useNodesState<FlowNode>([]);
  // The document's positions are authoritative except while a drag is running.
  const dragging = useRef(false);
  // The frame a dragged node would land in, so the drop can be seen coming.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // A wire let go over a node rather than on one of its handles (GP-250): which
  // of that node's arguments was meant is the question, and this is the asking.
  const [binding, setBinding] = useState<{
    from: string;
    to: string;
    at: { x: number; y: number };
  } | null>(null);
  const surface = useRef<HTMLDivElement>(null);

  const boxes = useMemo(() => absoluteBoxes(graph, catalog), [graph, catalog]);

  const built = useMemo<FlowNode[]>(() => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    return byDepth(graph).map((node) => {
      const held = node.id === selectedId ? HELD : 0;
      const shared = {
        id: node.id,
        position: relativePosition(boxes, node),
        selected: node.id === selectedId,
        ...(node.parentId && ids.has(node.parentId)
          ? { parentId: node.parentId, extent: "parent" as const }
          : {}),
      };
      if (drawsAsContainer(graph, node.id)) {
        const box = boxes.get(node.id);
        return {
          ...shared,
          type: "container" as const,
          // A frame is sized by what it holds; React Flow needs that in pixels.
          style: { width: box?.width, height: box?.height },
          // Frames are the ground everything else stands on. React Flow lifts
          // a child above its own parent by itself, but says nothing about a
          // card and the unrelated frame it happens to overlap — so a card is
          // put above every frame, and a nested frame above the one it is in.
          zIndex: FRAME_Z + held,
          data: {
            node,
            issues: byNode.get(node.id) ?? [],
            inputs: inputsOf(graph, node, catalog),
            depth: ancestorsOf(graph, node.id).length,
            dropping: dropTarget === node.id,
          },
        };
      }
      return {
        ...shared,
        type: "builder" as const,
        // A card is as wide as what is written on it, and the geometry that
        // sizes the frames around it is told the same number.
        style: { width: cardWidth(graph, node.id, catalog) },
        zIndex: CARD_Z + held,
        data: {
          node,
          def: defFor(node, catalog),
          issues: byNode.get(node.id) ?? [],
          inputs: inputsOf(graph, node, catalog),
        },
      };
    });
  }, [graph, boxes, byNode, selectedId, catalog, dropTarget]);

  // Keep the canvas in step with the document, without ever yanking a card out
  // from under the pointer: a node the canvas already has keeps its position.
  useEffect(() => {
    setFlowNodes((current) => {
      const positions = new Map(current.map((n) => [n.id, n.position]));
      return built.map((node) => ({
        ...node,
        position: dragging.current
          ? (positions.get(node.id) ?? node.position)
          : node.position,
      }));
    });
  }, [built, setFlowNodes]);

  /**
   * Edges are what containment cannot say. A reference to an ancestor is
   * already drawn — as the frame the node sits in — and drawing it twice would
   * be a wire from a card to the box around it.
   */
  const edges = useMemo<Edge[]>(() => {
    const ancestors = new Map(
      graph.nodes.map((n) => [n.id, new Set(ancestorsOf(graph, n.id).map((a) => a.id))]),
    );
    return graph.references
      .filter((reference) => !ancestors.get(reference.from)?.has(reference.to))
      .map((reference) => ({
        id: edgeId(reference.from, reference.attribute, reference.to),
        // The referenced resource is the source: the wire leaves what is
        // offered and arrives at what needs it.
        source: reference.to,
        target: reference.from,
        targetHandle: reference.attribute,
        label: reference.attribute,
        labelStyle: { fontSize: 10 },
      }));
  }, [graph]);

  /** Where a node's top-left is on the canvas, parents included. */
  const absoluteOf = useCallback(
    (id: string, position: { x: number; y: number }) => {
      const node = graph.nodes.find((n) => n.id === id);
      const parent = node?.parentId ? boxes.get(node.parentId) : undefined;
      return parent
        ? { x: parent.x + position.x, y: parent.y + position.y }
        : position;
    },
    [graph, boxes],
  );

  // The one place a connection is judged, and the reason an incompatible one
  // cannot be made rather than being explained after the fact.
  const isValidConnection = useCallback<IsValidConnection>(
    (connection) => {
      if (!connection.source || !connection.target || !connection.targetHandle) {
        return false;
      }
      // A custom resource takes any reference — it has no slots to disagree.
      if (connection.targetHandle === NEW_REFERENCE_HANDLE) {
        return connection.source !== connection.target;
      }
      return canAttach(
        graph,
        connection.target,
        connection.targetHandle,
        connection.source,
        catalog,
      );
    },
    [graph, catalog],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || !connection.targetHandle) {
        return;
      }
      onConnect(connection.target, connection.targetHandle, connection.source);
    },
    [onConnect],
  );

  /** What the open menu offers, recomputed from the graph it will change. */
  const bindable = useMemo<Bindable[]>(() => {
    if (!binding) return [];
    const target = graph.nodes.find((n) => n.id === binding.to);
    return target ? bindableOn(graph, target, binding.from, catalog) : [];
  }, [binding, graph, catalog]);

  const source = binding
    ? graph.nodes.find((n) => n.id === binding.from)
    : undefined;

  const handleEdgesDelete = useCallback(
    (removed: Edge[]) => {
      for (const edge of removed) {
        if (edge.targetHandle) {
          onDisconnect(edge.target, edge.targetHandle, edge.source);
        }
      }
    },
    [onDisconnect],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      // Applied locally first, so a drag is as smooth as React Flow can make it.
      onNodesChangeInternal(changes);
      for (const change of changes) {
        // `dragging` is undefined on a programmatic move, which is exactly the
        // case where the document's position is the one to keep.
        if (change.type === "position") dragging.current = change.dragging === true;
        if (change.type === "remove") onDelete(change.id);
        if (change.type === "select" && change.selected) onSelect(change.id);
      }
    },
    [onNodesChangeInternal, onDelete, onSelect],
  );

  return (
    <div ref={surface} className="relative h-full w-full">
    <ReactFlow
      nodes={flowNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={handleNodesChange}
      // Where a node is let go decides both things: where it sits, and what it
      // is now inside. The pointer is what the user aimed with, so the frame
      // under the pointer wins rather than the one under a corner.
      onNodeDrag={(event, node) => {
        const point = screenToFlowPosition(pointerOf(event));
        const dragged = graph.nodes.find((n) => n.id === node.id);
        setDropTarget(
          containerAt(graph, boxes, point, {
            ignore: node.id,
            catalog,
            ...(dragged ? { child: dragged } : {}),
          }) ?? null,
        );
      }}
      onNodeDragStop={(event, node) => {
        dragging.current = false;
        setDropTarget(null);
        const point = screenToFlowPosition(pointerOf(event));
        const dragged = graph.nodes.find((n) => n.id === node.id);
        const target = containerAt(graph, boxes, point, {
          ignore: node.id,
          catalog,
          ...(dragged ? { child: dragged } : {}),
        });
        const current = graph.nodes.find((n) => n.id === node.id)?.parentId;
        onMove(node.id, absoluteOf(node.id, node.position));
        if (target !== current) onNest(node.id, target);
      }}
      onEdgesDelete={handleEdgesDelete}
      onConnect={handleConnect}
      // A wire dropped anywhere on a node, rather than exactly on a handle.
      // React Flow only reports a `toNode` when a handle was within reach, so
      // the node under the pointer is found the same way a dropped card finds
      // its frame — from the geometry this canvas already keeps.
      onConnectEnd={(event, state) => {
        if (state.isValid) return;
        const fromHandle = state.fromHandle;
        const fromNode = state.fromNode;
        if (!fromHandle || !fromNode) return;
        const point = screenToFlowPosition(pointerOf(event));
        const landed = nodeAt(graph, boxes, point);
        if (!landed || landed === fromNode.id) return;

        // Dragged *from* an argument: which one is not in question, so the
        // wire simply lands if the rules allow it.
        if (fromHandle.type === "target") {
          const attribute = fromHandle.id;
          if (attribute === NEW_REFERENCE_HANDLE) {
            onConnect(fromNode.id, NEW_REFERENCE_HANDLE, landed);
          } else if (
            attribute &&
            canAttach(graph, fromNode.id, attribute, landed, catalog)
          ) {
            onConnect(fromNode.id, attribute, landed);
          }
          return;
        }

        // A resource the catalog does not describe has no arguments to choose
        // between: it grows one named after what was dropped on it.
        const target = graph.nodes.find((n) => n.id === landed);
        if (target?.custom) {
          onConnect(landed, NEW_REFERENCE_HANDLE, fromNode.id);
          return;
        }
        const box = surface.current?.getBoundingClientRect();
        const pointer = pointerOf(event);
        setBinding({
          from: fromNode.id,
          to: landed,
          at: {
            x: pointer.x - (box?.left ?? 0),
            y: pointer.y - (box?.top ?? 0),
          },
        });
      }}
      isValidConnection={isValidConnection}
      nodesConnectable
      // Selecting is not a reason to reorder the canvas: React Flow's default
      // lifts a selected node a thousand levels, which would float a clicked
      // frame over the cards that are meant to sit on top of it.
      elevateNodesOnSelect={false}
      // Both keys, because both are "delete this" depending on the keyboard:
      // Backspace is React Flow's default and the only one a Mac laptop has,
      // Delete is what everyone else reaches for. Safe next to the form and
      // the palette search — React Flow ignores key events that originate
      // inside an input, so backspacing through an attribute value never
      // deletes the resource being edited.
      deleteKeyCode={["Delete", "Backspace"]}
      onPaneClick={() => onSelect(null)}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(PALETTE_MIME)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => {
        const type = event.dataTransfer.getData(PALETTE_MIME);
        if (!type) return;
        event.preventDefault();
        const point = screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        });
        const parentId = containerAt(graph, boxes, point, {
          catalog,
          child: type,
        });
        const parent = parentId ? boxes.get(parentId) : undefined;
        // Dropped into a frame: keep the point, but never under its own label.
        const position = parent
          ? {
              x: Math.max(parent.x + CONTAINER_PADDING, point.x),
              y: Math.max(parent.y + CONTAINER_HEADER, point.y),
            }
          : point;
        onDrop(type, position, parentId);
      }}
      nodesDraggable
      fitView
      proOptions={{ hideAttribution: true }}
      aria-label="Builder canvas"
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      {/* React Flow ships its controls light-themed; ours follow the app's
          tokens, in every theme. */}
      <Controls
        showInteractive={false}
        className="[&>button]:!border-border [&>button]:!bg-card [&>button]:!fill-foreground [&>button:hover]:!bg-accent"
      />
    </ReactFlow>

      {/* Dropped on the node, not on one of its arguments — so the menu opens
          where the wire was let go and asks which one was meant (GP-250). The
          trigger has no size of its own: it is only what the menu is anchored
          to, which is how a menu ends up at a pointer rather than at a
          control. */}
      <DropdownMenu
        open={binding !== null}
        onOpenChange={(open) => {
          if (!open) setBinding(null);
        }}
      >
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute size-0"
            style={{ left: binding?.at.x ?? 0, top: binding?.at.y ?? 0 }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-[11px] font-normal">
            {source ? (
              <>
                Use{" "}
                <span className="text-ink font-mono">{addressOf(source)}</span>{" "}
                for…
              </>
            ) : (
              "Connect…"
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {bindable.length === 0 ? (
            <DropdownMenuItem disabled className="text-[11px]">
              Nothing here takes it
            </DropdownMenuItem>
          ) : (
            bindable.map((row) => (
              <DropdownMenuItem
                key={row.attribute}
                className="text-xs"
                onSelect={() => {
                  if (binding) onConnect(binding.to, row.attribute, binding.from);
                  setBinding(null);
                }}
              >
                <span className="flex-1">{row.label}</span>
                {row.required && (
                  <span className="text-faint font-mono text-[10px]">
                    required
                  </span>
                )}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function BuilderCanvas(props: Readonly<BuilderCanvasProps>) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
