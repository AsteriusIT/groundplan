/**
 * Resource → owning-organization resolution (GP-114). Every org-scoped route is
 * addressed under `/api/v1/orgs/:orgId/...`; the org-scope guard uses this module
 * to prove the *addressed resource* actually belongs to `:orgId` — otherwise a
 * member of org A could reach org B's snapshot by putting A in the path. A miss
 * is a 404 (no existence leak), never a 403.
 *
 * The mapping from a route to the resource it addresses is by the first path
 * segment after the org prefix; the primary id is always the route's `:id` param.
 * Nested routes (`/repositories/:id/pulls`) resolve on their parent id, so their
 * children are in-org transitively — only the parent needs checking.
 */
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  annotations,
  clusters,
  graphSnapshots,
  projects,
  repositories,
  shareTokens,
} from "../db/schema.js";

export type ResourceKind =
  | "project"
  | "repository"
  | "snapshot"
  | "cluster"
  | "annotation"
  | "shareLink";

/** Which resource a route's `:id` addresses, keyed by its first path segment. */
export const RESOURCE_BY_SEGMENT: Record<string, ResourceKind> = {
  projects: "project",
  repositories: "repository",
  snapshots: "snapshot",
  clusters: "cluster",
  annotations: "annotation",
  "share-links": "shareLink",
};

/**
 * The resource kind a route addresses, or null when the route is a collection or
 * whole-org endpoint (`/projects` list, `/clusters` create, `/dashboard`) whose
 * ownership is enforced by the handler filtering on the org instead.
 */
export function resourceKindForRoute(
  routeUrl: string | undefined,
): ResourceKind | null {
  if (!routeUrl) return null;
  const rest = routeUrl.replace(/^\/api\/v1\/orgs\/:orgId\/?/, "");
  const segment = rest.split("/")[0] ?? "";
  return RESOURCE_BY_SEGMENT[segment] ?? null;
}

/**
 * The organization that owns a resource, or null if the resource does not exist.
 * A snapshot hangs off a repository XOR a cluster, so it resolves through either.
 */
export async function resolveResourceOrg(
  db: NodePgDatabase,
  kind: ResourceKind,
  id: string,
): Promise<string | null> {
  switch (kind) {
    case "project": {
      const [row] = await db
        .select({ orgId: projects.organizationId })
        .from(projects)
        .where(eq(projects.id, id));
      return row?.orgId ?? null;
    }
    case "cluster": {
      const [row] = await db
        .select({ orgId: clusters.organizationId })
        .from(clusters)
        .where(eq(clusters.id, id));
      return row?.orgId ?? null;
    }
    case "repository": {
      const [row] = await db
        .select({ orgId: projects.organizationId })
        .from(repositories)
        .innerJoin(projects, eq(repositories.projectId, projects.id))
        .where(eq(repositories.id, id));
      return row?.orgId ?? null;
    }
    case "annotation": {
      const [row] = await db
        .select({ orgId: projects.organizationId })
        .from(annotations)
        .innerJoin(repositories, eq(annotations.repositoryId, repositories.id))
        .innerJoin(projects, eq(repositories.projectId, projects.id))
        .where(eq(annotations.id, id));
      return row?.orgId ?? null;
    }
    case "shareLink": {
      const [row] = await db
        .select({ orgId: projects.organizationId })
        .from(shareTokens)
        .innerJoin(repositories, eq(shareTokens.repositoryId, repositories.id))
        .innerJoin(projects, eq(repositories.projectId, projects.id))
        .where(eq(shareTokens.id, id));
      return row?.orgId ?? null;
    }
    case "snapshot": {
      const [row] = await db
        .select({
          repoOrg: projects.organizationId,
          clusterOrg: clusters.organizationId,
        })
        .from(graphSnapshots)
        .leftJoin(repositories, eq(graphSnapshots.repositoryId, repositories.id))
        .leftJoin(projects, eq(repositories.projectId, projects.id))
        .leftJoin(clusters, eq(graphSnapshots.clusterId, clusters.id))
        .where(eq(graphSnapshots.id, id));
      if (!row) return null;
      return row.repoOrg ?? row.clusterOrg ?? null;
    }
  }
}
