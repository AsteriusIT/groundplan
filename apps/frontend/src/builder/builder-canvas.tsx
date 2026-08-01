/**
 * The builder's canvas (GP-133) — a React Flow editor, deliberately not the
 * read-only `@groundplan/canvas` one. Creating, connecting and deleting is a
 * different job from rendering a snapshot, and that canvas is also the VS Code
 * webview's; an editor does not belong in it.
 *
 * No layout engine here either: positions are the user's, and an ELK pass that
 * moved a card somebody placed would be the tool arguing with its user.
 */
import { useCallback, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type IsValidConnection,
  type NodeChange,
} from "@xyflow/react";

import {
  issuesByNode,
  resourceDef,
  type BuilderGraph,
  type BuilderIssue,
} from "@groundplan/builder";

import { canAttach } from "./builder-ops";
import {
  BuilderResourceNode,
  type BuilderFlowNode,
} from "./builder-node";

import "@xyflow/react/dist/style.css";

const nodeTypes = { builder: BuilderResourceNode };

export type BuilderCanvasProps = {
  graph: BuilderGraph;
  issues: readonly BuilderIssue[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, position: { x: number; y: number }) => void;
  onConnect: (from: string, attribute: string, to: string) => void;
  onDisconnect: (from: string, attribute: string, to: string) => void;
  onDelete: (id: string) => void;
};

/** `from|attribute|to` — an edge id that says exactly which slot it fills. */
function edgeId(from: string, attribute: string, to: string): string {
  return `${from}|${attribute}|${to}`;
}

function Canvas({
  graph,
  issues,
  selectedId,
  onSelect,
  onMove,
  onConnect,
  onDisconnect,
  onDelete,
}: Readonly<BuilderCanvasProps>) {
  const byNode = useMemo(() => issuesByNode(issues), [issues]);

  const nodes = useMemo<BuilderFlowNode[]>(() => {
    const names = new Map(graph.nodes.map((n) => [n.id, n.name]));
    return graph.nodes.flatMap((node) => {
      const def = resourceDef(node.type);
      if (!def) return [];
      const connected: Record<string, string[]> = {};
      for (const reference of graph.references) {
        if (reference.from !== node.id) continue;
        const name = names.get(reference.to);
        if (!name) continue;
        connected[reference.attribute] = [
          ...(connected[reference.attribute] ?? []),
          name,
        ];
      }
      return [
        {
          id: node.id,
          type: "builder" as const,
          position: node.position,
          selected: node.id === selectedId,
          data: { node, def, issues: byNode.get(node.id) ?? [], connected },
        },
      ];
    });
  }, [graph, byNode, selectedId]);

  const edges = useMemo<Edge[]>(
    () =>
      graph.references.map((reference) => ({
        id: edgeId(reference.from, reference.attribute, reference.to),
        source: reference.from,
        sourceHandle: reference.attribute,
        target: reference.to,
        label: reference.attribute,
        labelStyle: { fontSize: 10 },
      })),
    [graph.references],
  );

  // The one place a connection is judged, and the reason an incompatible one
  // cannot be made rather than being explained after the fact.
  const isValidConnection = useCallback<IsValidConnection>(
    (connection) =>
      Boolean(
        connection.source &&
          connection.target &&
          connection.sourceHandle &&
          canAttach(
            graph,
            connection.source,
            connection.sourceHandle,
            connection.target,
          ),
      ),
    [graph],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || !connection.sourceHandle) {
        return;
      }
      onConnect(connection.source, connection.sourceHandle, connection.target);
    },
    [onConnect],
  );

  const handleNodesChange = useCallback(
    (changes: NodeChange<BuilderFlowNode>[]) => {
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          onMove(change.id, change.position);
        }
        if (change.type === "remove") onDelete(change.id);
        if (change.type === "select" && change.selected) onSelect(change.id);
      }
    },
    [onMove, onDelete, onSelect],
  );

  const handleEdgesDelete = useCallback(
    (removed: Edge[]) => {
      for (const edge of removed) {
        if (edge.sourceHandle) {
          onDisconnect(edge.source, edge.sourceHandle, edge.target);
        }
      }
    },
    [onDisconnect],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={handleNodesChange}
      onEdgesDelete={handleEdgesDelete}
      onConnect={handleConnect}
      isValidConnection={isValidConnection}
      onPaneClick={() => onSelect(null)}
      nodesDraggable
      nodesConnectable
      fitView
      proOptions={{ hideAttribution: true }}
      aria-label="Builder canvas"
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      <Controls showInteractive={false} />
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
