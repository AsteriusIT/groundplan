/**
 * Docs-snapshot diff (GP-40): compare two `source=hcl` graphs by resource
 * address to answer "what changed in our infra since last time" — what appeared,
 * what disappeared, what moved modules. Pure set diff (no attribute-level
 * comparison for HCL snapshots). Modules are structural and ignored.
 *
 * A resource whose bare address (`type.name`) survives but whose module path
 * changed is reported as *moved* (rare) rather than an add + a remove.
 */
import type { Graph, GraphNode } from "./graph.js";

export interface DiffNode {
  id: string;
  name: string;
  type: string;
  module_path: string[];
}

export interface MovedNode {
  id: string;
  name: string;
  type: string;
  from_module_path: string[];
  to_module_path: string[];
}

export interface GraphDiff {
  added: DiffNode[];
  removed: DiffNode[];
  moved: MovedNode[];
  unchangedCount: number;
}

const isResource = (n: GraphNode): boolean => n.type !== "module";
const bareAddress = (n: GraphNode): string => `${n.type}.${n.name}`;
const byId = (a: { id: string }, b: { id: string }): number => {
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
};

const toDiffNode = (n: GraphNode): DiffNode => ({
  id: n.id,
  name: n.name,
  type: n.type,
  module_path: n.module_path,
});

/** Diff the resource sets of two graphs (base → target). */
export function diffGraphs(base: Graph, target: Graph): GraphDiff {
  const baseNodes = base.nodes.filter(isResource);
  const targetNodes = target.nodes.filter(isResource);
  const baseIds = new Set(baseNodes.map((n) => n.id));
  const targetIds = new Set(targetNodes.map((n) => n.id));

  let unchangedCount = 0;
  for (const id of targetIds) if (baseIds.has(id)) unchangedCount += 1;

  const rawAdded = targetNodes.filter((n) => !baseIds.has(n.id));
  const rawRemoved = baseNodes.filter((n) => !targetIds.has(n.id));

  // Pair a removed and an added node sharing a bare address → moved (one-to-one,
  // deterministic by id). Anything left over is a genuine add / remove.
  const removedByAddr = new Map<string, GraphNode[]>();
  for (const n of rawRemoved) {
    const list = removedByAddr.get(bareAddress(n));
    if (list) list.push(n);
    else removedByAddr.set(bareAddress(n), [n]);
  }
  for (const list of removedByAddr.values()) list.sort(byId);

  const moved: MovedNode[] = [];
  const movedAddedIds = new Set<string>();
  const movedRemovedIds = new Set<string>();
  for (const addedNode of [...rawAdded].sort(byId)) {
    const candidates = removedByAddr.get(bareAddress(addedNode));
    const match = candidates?.find((c) => !movedRemovedIds.has(c.id));
    if (match) {
      moved.push({
        id: addedNode.id,
        name: addedNode.name,
        type: addedNode.type,
        from_module_path: match.module_path,
        to_module_path: addedNode.module_path,
      });
      movedAddedIds.add(addedNode.id);
      movedRemovedIds.add(match.id);
    }
  }

  const added = rawAdded
    .filter((n) => !movedAddedIds.has(n.id))
    .map(toDiffNode)
    .sort(byId);
  const removed = rawRemoved
    .filter((n) => !movedRemovedIds.has(n.id))
    .map(toDiffNode)
    .sort(byId);

  moved.sort(byId);
  return { added, removed, moved, unchangedCount };
}
