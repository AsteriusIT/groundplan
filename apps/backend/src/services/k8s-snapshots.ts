import type { FastifyInstance } from "fastify";

import type { ClusterRow, GraphSnapshotRow } from "../db/schema.js";
import type { UnresolvedReference } from "../graph/graph.js";
import { mapNamespace } from "../graph/k8s-mapper.js";
import { insertGraphSnapshot } from "./graph-snapshots.js";

/** Thrown when a generation is already running for this (cluster, namespace). */
export class K8sGenerationInProgressError extends Error {
  constructor() {
    super("a snapshot of this namespace is already being generated");
    this.name = "K8sGenerationInProgressError";
  }
}

// One generation in flight per (cluster, namespace) — the docs-flow rule (GP-15),
// for the same reason: two reads of the same namespace at the same time cost the
// cluster twice and answer the same question. Acquired synchronously, before the
// first await, so two overlapping requests cannot both pass the guard.
const generating = new Set<string>();

const key = (clusterId: string, namespace: string) => `${clusterId}/${namespace}`;

/**
 * Producer C's shell (GP-97): read one namespace, map it (GP-96), store it as an
 * ordinary snapshot with `source=k8s_namespace`.
 *
 * A live read has no commit, so `commitSha` is empty and `ref` carries the
 * namespace — the fields mean what they can mean here, rather than being faked.
 * The reader's `warnings` (kinds RBAC would not let us list) ride in `stats`,
 * exactly where the docs flow puts its parse warnings, so the frontend surfaces
 * both with one code path.
 */
export async function generateNamespaceSnapshot(
  app: FastifyInstance,
  cluster: ClusterRow,
  namespace: string,
): Promise<GraphSnapshotRow> {
  const lock = key(cluster.id, namespace);
  if (generating.has(lock)) throw new K8sGenerationInProgressError();
  generating.add(lock);
  try {
    const kubeconfig = app.encryptor.decrypt(cluster.kubeconfig);
    const { resources, warnings } = await app.k8s.readNamespace(kubeconfig, namespace);

    const unresolved: UnresolvedReference[] = [];
    const graph = mapNamespace(resources, { unresolved });
    return await insertGraphSnapshot(app.db, {
      clusterId: cluster.id,
      namespace,
      source: "k8s_namespace",
      ref: namespace,
      commitSha: "",
      graph,
      extraStats: {
        warnings,
        ...(unresolved.length > 0 ? { unresolvedReferences: unresolved } : {}),
      },
    });
  } finally {
    generating.delete(lock);
  }
}
