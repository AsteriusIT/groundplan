/**
 * The builder's canvas (GP-133) — a React Flow editor, deliberately not the
 * read-only `@groundplan/canvas` one. Creating, connecting and deleting is a
 * different job from rendering a snapshot, and that canvas is also the VS Code
 * webview's.
 *
 * Positions live in React Flow while a node is being dragged and land in the
 * document when the drag ends. Feeding every frame back through the document
 * made the card flicker: the canvas moved it, the re-render put it back where
 * the document still said it was, and the next frame moved it again.
 *
 * No layout engine either: positions are the user's, and an ELK pass that moved
 * a card somebody placed would be the tool arguing with its user.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
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
  CATALOG,
  issuesByNode,
  resourceDef,
  type BuilderGraph,
  type BuilderIssue,
  type BuilderNode,
  type ResourceDef,
} from "@groundplan/builder";

import { canAttach } from "./builder-ops";
import {
  BuilderResourceNode,
  NEW_REFERENCE_HANDLE,
  type BuilderFlowNode,
  type BuilderInput,
} from "./builder-node";

import "@xyflow/react/dist/style.css";

const nodeTypes = { builder: BuilderResourceNode };

/** The drag-and-drop payload: which catalog type is being dropped. */
export const PALETTE_MIME = "application/x-groundplan-resource";

export type BuilderCanvasProps = {
  graph: BuilderGraph;
  /** What the canvas draws slots and connection rules from (GP-238). */
  catalog?: readonly ResourceDef[];
  issues: readonly BuilderIssue[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, position: { x: number; y: number }) => void;
  onConnect: (from: string, attribute: string, to: string) => void;
  onDisconnect: (from: string, attribute: string, to: string) => void;
  onDelete: (id: string) => void;
  /** A palette entry dropped on the canvas, at the point it was dropped. */
  onDrop: (type: string, position: { x: number; y: number }) => void;
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

function Canvas({
  graph,
  catalog = CATALOG,
  issues,
  selectedId,
  onSelect,
  onMove,
  onConnect,
  onDisconnect,
  onDelete,
  onDrop,
}: Readonly<BuilderCanvasProps>) {
  const byNode = useMemo(() => issuesByNode(issues), [issues]);
  const { screenToFlowPosition } = useReactFlow();
  const [flowNodes, setFlowNodes, onNodesChangeInternal] =
    useNodesState<BuilderFlowNode>([]);
  // The document's positions are authoritative except while a drag is running.
  const dragging = useRef(false);

  const built = useMemo<BuilderFlowNode[]>(() => {
    const names = new Map(graph.nodes.map((n) => [n.id, n.name]));
    return graph.nodes.map((node) => ({
      id: node.id,
      type: "builder" as const,
      position: node.position,
      selected: node.id === selectedId,
      data: {
        node,
        def: resourceDef(node.type, catalog),
        issues: byNode.get(node.id) ?? [],
        inputs: inputsOf(node, graph, names, catalog),
      },
    }));
  }, [graph, byNode, selectedId, catalog]);

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

  const edges = useMemo<Edge[]>(
    () =>
      graph.references.map((reference) => ({
        id: edgeId(reference.from, reference.attribute, reference.to),
        // The referenced resource is the source: the wire leaves what is
        // offered and arrives at what needs it.
        source: reference.to,
        target: reference.from,
        targetHandle: reference.attribute,
        label: reference.attribute,
        labelStyle: { fontSize: 10 },
      })),
    [graph.references],
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

  const handleNodesChange = useCallback(
    (changes: NodeChange<BuilderFlowNode>[]) => {
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

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={handleNodesChange}
      // The position the user let go of is the one worth recording.
      onNodeDragStop={(_event, node) => {
        dragging.current = false;
        onMove(node.id, node.position);
      }}
      onEdgesDelete={handleEdgesDelete}
      onConnect={handleConnect}
      isValidConnection={isValidConnection}
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
        onDrop(
          type,
          screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        );
      }}
      nodesDraggable
      nodesConnectable
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
