/**
 * Tenant scoping (GP-114). Every org-owned resource is registered under this
 * plugin at the prefix `/api/v1/orgs/:orgId`. Its `preHandler` runs for all of
 * them and enforces two things, in order:
 *
 *   1. Membership — the caller must belong to `:orgId`. A non-member (or an
 *      unknown org) gets 404, never 403: the API must not leak that an org exists
 *      to someone outside it.
 *   2. Ownership — the resource the route addresses (`/repositories/:id`,
 *      `/snapshots/:id`, …) must actually belong to `:orgId`, otherwise a member
 *      of one org could reach another org's resource by putting their own org in
 *      the path. A mismatch is again a 404.
 *
 * When OIDC auth is disabled (dev/test, the app's existing open-mode default),
 * there is no `authUser` to resolve a membership for, so the guard grants `owner`
 * — which keeps the large existing route-test suite (which runs unauthenticated)
 * working while the RBAC-specific tests run with auth on to exercise the matrix.
 *
 * The webhook (`/webhooks/ci/*`), the public share views (`/public/*`), `/me`,
 * `/orgs` management and `/ai/status` are deliberately NOT under this plugin —
 * they are global by design (see app.ts).
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";

import { memberships, organizations } from "../db/schema.js";
import type { Role } from "../rbac/permissions.js";
import { resolveResourceOrg, resourceKindForRoute } from "../rbac/ownership.js";
import "../rbac/request.js";

// Route plugins that become org-scoped.
import { aiRoutes } from "../routes/ai.js";
import { annotationRoutes } from "../routes/annotations.js";
import { clusterRoutes } from "../routes/clusters.js";
import { confluenceRoutes } from "../routes/confluence.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { docsRoutes } from "../routes/docs.js";
import { exportRoutes } from "../routes/exports.js";
import { repositoryEventsRoutes } from "../routes/ingestion.js";
import { integrationRoutes } from "../routes/integrations.js";
import { invitationRoutes } from "../routes/invitations.js";
import { k8sSnapshotRoutes } from "../routes/k8s-snapshots.js";
import { memberRoutes } from "../routes/members.js";
import { projectRoutes } from "../routes/projects.js";
import { pullRoutes } from "../routes/pulls.js";
import { repositoryFileRoutes } from "../routes/repository-files.js";
import { repositoryRoutes } from "../routes/repositories.js";
import { shareRoutes } from "../routes/share-links.js";
import { snapshotRoutes } from "../routes/snapshots.js";
import { tourRoutes } from "../routes/tours.js";

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The org id from the raw URL. We read it from `request.url` rather than
 * `request.params.orgId` because Fastify's parametric prefix (`:orgId`) drops the
 * prefix param on routes that carry their own param too (e.g.
 * `/orgs/:orgId/projects/:id/repositories` yields only `{id}`). The URL is always
 * intact, so this is the reliable source.
 */
const ORG_URL_RE = /^\/api\/v1\/orgs\/([^/?#]+)/;
function orgIdFromUrl(url: string): string | null {
  const match = ORG_URL_RE.exec(url);
  return match ? match[1]! : null;
}

function notFound(reply: FastifyReply, message: string) {
  return reply.code(404).send({ error: "Not Found", message });
}

export const orgScopePlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest("membership", undefined);

  app.addHook("preHandler", async (request, reply) => {
    const orgId = orgIdFromUrl(request.url);
    if (!orgId || !UUID_RE.test(orgId)) {
      return notFound(reply, "organization not found");
    }

    const [org] = await app.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (!org) return notFound(reply, "organization not found");

    let role: Role;
    if (request.authUser) {
      const [member] = await app.db
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, request.authUser.id),
            eq(memberships.organizationId, orgId),
          ),
        );
      // A non-member must not learn the org exists.
      if (!member) return notFound(reply, "organization not found");
      role = member.role;
    } else {
      // Auth disabled (dev/test) → open access.
      role = "owner";
    }
    request.membership = { orgId, role };

    // The addressed resource must belong to this org.
    const kind = resourceKindForRoute(request.routeOptions?.url);
    const id = (request.params as { id?: string }).id;
    if (kind && id) {
      const owner = await resolveResourceOrg(app.db, kind, id);
      if (owner !== orgId) return notFound(reply, "resource not found");
    }
  });

  await app.register(projectRoutes);
  await app.register(repositoryRoutes);
  await app.register(repositoryFileRoutes);
  await app.register(repositoryEventsRoutes);
  await app.register(snapshotRoutes);
  await app.register(exportRoutes);
  await app.register(pullRoutes);
  await app.register(docsRoutes);
  await app.register(annotationRoutes);
  await app.register(aiRoutes);
  await app.register(tourRoutes);
  await app.register(dashboardRoutes);
  await app.register(clusterRoutes);
  await app.register(integrationRoutes);
  await app.register(confluenceRoutes);
  await app.register(k8sSnapshotRoutes);
  await app.register(shareRoutes);
  await app.register(invitationRoutes);
  await app.register(memberRoutes);
};
