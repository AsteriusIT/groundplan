/**
 * The builder's canvas (GP-133, containment in GP-247) — a React Flow editor,
 * deliberately not the read-only `@groundplan/canvas` one. Creating, nesting and
 * deleting is a different job from rendering a snapshot, and that canvas is also
 * the VS Code webview's.
 *
 * Hierarchy is drawn as **space, not arrows**: a subnet inside a virtual network
 * inside a resource group. There is no edge tool, because there is nothing an
 * edge would say that the nesting does not — dropping a node into a frame fills
 * the reference slot that takes that frame's type (see `builder-ops.reparent`).
 * References the nesting cannot express — a public IP on a NIC — are still
 * drawn, and still made in the form: they are shown, never dragged.
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
  type Edge,
  type NodeChange,
} from "@xyflow/react";

import {
  ancestorsOf,
  CATALOG,
  issuesByNode,
  resourceDef,
  type BuilderGraph,
  type BuilderIssue,
  type BuilderNode,
  type ResourceDef,
} from "@groundplan/builder";

import {
  BuilderContainerNode,
  type BuilderContainerFlowNode,
} from "./builder-container-node";
import {
  absoluteBoxes,
  byDepth,
  containerAt,
  CONTAINER_HEADER,
  CONTAINER_PADDING,
  drawsAsContainer,
  relativePosition,
} from "./builder-layout";
import {
  BuilderResourceNode,
  type BuilderFlowNode,
  type BuilderInput,
} from "./builder-node";

import "@xyflow/react/dist/style.css";

const nodeTypes = { builder: BuilderResourceNode, container: BuilderContainerNode };

type FlowNode = BuilderFlowNode | BuilderContainerFlowNode;

/** The drag-and-drop payload: which catalog type is being dropped. */
export const PALETTE_MIME = "application/x-groundplan-resource";

export type BuilderCanvasProps = {
  graph: BuilderGraph;
  /** What the canvas draws slots and nesting rules from (GP-238). */
  catalog?: readonly ResourceDef[];
  issues: readonly BuilderIssue[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, position: { x: number; y: number }) => void;
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

/** The input rows of a node: its catalog slots, or a custom node's references. */
function inputsOf(
  node: BuilderNode,
  graph: BuilderGraph,
  names: Map<string, string>,
  catalog: readonly ResourceDef[],
): BuilderInput[] {
  const targetsOf = (attribute: string) =>
    graph.references
      .filter((r) => r.from === node.id && r.attribute === attribute)
      .flatMap((r) => {
        const name = names.get(r.to);
        return name ? [name] : [];
      });

  if (node.custom) {
    const seen = new Set<string>();
    return graph.references
      .filter((r) => r.from === node.id && !seen.has(r.attribute))
      .map((r) => {
        seen.add(r.attribute);
        return {
          attribute: r.attribute,
          label: r.attribute,
          required: false,
          targets: targetsOf(r.attribute),
        };
      });
  }

  const def = resourceDef(node.type, catalog);
  return (def?.references ?? []).map((slot) => ({
    attribute: slot.attribute,
    label: slot.label,
    required: slot.required,
    targets: targetsOf(slot.attribute),
  }));
}

/** `from|attribute|to` — an edge id that says exactly which slot it fills. */
function edgeId(from: string, attribute: string, to: string): string {
  return `${from}|${attribute}|${to}`;
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

  const boxes = useMemo(() => absoluteBoxes(graph, catalog), [graph, catalog]);

  const built = useMemo<FlowNode[]>(() => {
    const names = new Map(graph.nodes.map((n) => [n.id, n.name]));
    return byDepth(graph).map((node) => {
      const shared = {
        id: node.id,
        position: relativePosition(boxes, node),
        selected: node.id === selectedId,
        ...(node.parentId && names.has(node.parentId)
          ? { parentId: node.parentId, extent: "parent" as const }
          : {}),
      };
      if (drawsAsContainer(graph, node.id, catalog)) {
        const box = boxes.get(node.id);
        return {
          ...shared,
          type: "container" as const,
          // A frame is sized by what it holds; React Flow needs that in pixels.
          style: { width: box?.width, height: box?.height },
          data: {
            node,
            issues: byNode.get(node.id) ?? [],
            depth: ancestorsOf(graph, node.id).length,
            dropping: dropTarget === node.id,
          },
        };
      }
      return {
        ...shared,
        type: "builder" as const,
        data: {
          node,
          def: resourceDef(node.type, catalog),
          issues: byNode.get(node.id) ?? [],
          inputs: inputsOf(node, graph, names, catalog),
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
        setDropTarget(containerAt(graph, boxes, point, node.id) ?? null);
      }}
      onNodeDragStop={(event, node) => {
        dragging.current = false;
        setDropTarget(null);
        const point = screenToFlowPosition(pointerOf(event));
        const target = containerAt(graph, boxes, point, node.id);
        const current = graph.nodes.find((n) => n.id === node.id)?.parentId;
        onMove(node.id, absoluteOf(node.id, node.position));
        if (target !== current) onNest(node.id, target);
      }}
      // No connection is dragged in this editor: hierarchy is containment, and
      // the references containment cannot express are made in the form.
      nodesConnectable={false}
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
        const parentId = containerAt(graph, boxes, point);
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
  );
}

export function BuilderCanvas(props: Readonly<BuilderCanvasProps>) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
