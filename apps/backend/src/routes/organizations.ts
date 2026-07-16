import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { and, desc, eq } from "drizzle-orm";

import {
  memberRole,
  memberships,
  organizations,
  toPublicOrganization,
  users,
} from "../db/schema.js";
import { isUniqueViolation } from "../lib/db-errors.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const orgIdParamsSchema = {
  type: "object",
  required: ["orgId"],
  additionalProperties: false,
  properties: { orgId: { type: "string", pattern: UUID_PATTERN } },
};

const createOrgSchema = {
  type: "object",
  required: ["name", "slug"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    slug: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    },
  },
};

const renameOrgSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
  },
};

const deleteOrgSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    confirmName: { type: "string" },
  },
};

type Role = (typeof memberRole.enumValues)[number];

/**
 * The caller's role in an org — or "open" when auth is disabled (dev/test), which
 * behaves as full access, mirroring the app's dev-open auth philosophy, or null
 * when the caller is authenticated but not a member (used to 404 without leaking
 * the org's existence). The full RBAC guard lands in GP-114; this is the minimum
 * GP-113 needs for its own owner-only delete.
 */
async function callerRole(
  app: Parameters<FastifyPluginAsync>[0],
  request: FastifyRequest,
  orgId: string,
): Promise<Role | "open" | null> {
  if (!request.authUser) return "open";
  const [row] = await app.db
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, request.authUser.id),
        eq(memberships.organizationId, orgId),
      ),
    );
  return row?.role ?? null;
}

export const orgRoutes: FastifyPluginAsync = async (app) => {
  // The organizations the caller belongs to, with their role. Empty when auth is
  // disabled (no user to resolve memberships for).
  app.get("/orgs", async (request) => {
    if (!request.authUser) return [];
    const rows = await app.db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        createdAt: organizations.createdAt,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
      .where(eq(memberships.userId, request.authUser.id))
      .orderBy(desc(organizations.createdAt));
    return rows;
  });

  app.post(
    "/orgs",
    { schema: { body: createOrgSchema } },
    async (request, reply) => {
      // Single-org (self-hosted) mode: everyone shares the one seeded org, so
      // creating more is disabled (GP-115). SaaS mode is where users make orgs.
      if (app.singleOrg) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "organization creation is disabled in single-org mode",
        });
      }
      const { name, slug } = request.body as { name: string; slug: string };
      try {
        const [org] = await app.db
          .insert(organizations)
          .values({ name, slug })
          .returning();
        // The creator owns the org they made (GP-113). No-op when auth is off.
        if (request.authUser) {
          await app.db.insert(memberships).values({
            userId: request.authUser.id,
            organizationId: org!.id,
            role: "owner",
          });
        }
        return reply.code(201).send(toPublicOrganization(org!));
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply
            .code(409)
            .send({ error: "Conflict", message: `slug '${slug}' already exists` });
        }
        throw err;
      }
    },
  );

  app.get(
    "/orgs/:orgId",
    { schema: { params: orgIdParamsSchema } },
    async (request, reply) => {
      const { orgId } = request.params as { orgId: string };
      const [org] = await app.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, orgId));
      // A non-member must not learn the org exists (GP-114 no-leak rule).
      if (!org || (await callerRole(app, request, orgId)) === null) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "organization not found" });
      }
      return toPublicOrganization(org);
    },
  );

  app.patch(
    "/orgs/:orgId",
    { schema: { params: orgIdParamsSchema, body: renameOrgSchema } },
    async (request, reply) => {
      const { orgId } = request.params as { orgId: string };
      const body = request.body as { name?: string };
      const [org] = await app.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, orgId));
      const role = await callerRole(app, request, orgId);
      if (!org || role === null) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "organization not found" });
      }
      // Renaming is an admin/owner action (member is read-only). "open" = dev.
      if (role === "member") {
        return reply
          .code(403)
          .send({ error: "Forbidden", message: "admin role required" });
      }
      const [updated] = await app.db
        .update(organizations)
        .set({ ...(body.name !== undefined ? { name: body.name } : {}) })
        .where(eq(organizations.id, orgId))
        .returning();
      return toPublicOrganization(updated!);
    },
  );

  app.delete(
    "/orgs/:orgId",
    { schema: { params: orgIdParamsSchema, body: deleteOrgSchema } },
    async (request, reply) => {
      const { orgId } = request.params as { orgId: string };
      const { confirmName } = (request.body ?? {}) as { confirmName?: string };
      const [org] = await app.db
        .select()
        .from(organizations)
        .where(eq(organizations.id, orgId));
      const role = await callerRole(app, request, orgId);
      if (!org || role === null) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "organization not found" });
      }
      // Deleting an org (and cascading its projects/repos/snapshots) is an
      // owner-only action, gated locally here already (GP-113).
      if (role !== "open" && role !== "owner") {
        return reply
          .code(403)
          .send({ error: "Forbidden", message: "owner role required" });
      }
      // A name confirmation is required — deletion is destructive and cascades.
      if (confirmName !== org.name) {
        return reply.code(422).send({
          error: "Unprocessable Entity",
          message: "confirmName must match the organization name",
          fields: [{ field: "confirmName", message: "does not match" }],
        });
      }
      await app.db.delete(organizations).where(eq(organizations.id, orgId));
      return reply.code(204).send();
    },
  );

  // Read the org's members (name, email, role, joined date) — the membership API.
  app.get(
    "/orgs/:orgId/members",
    { schema: { params: orgIdParamsSchema } },
    async (request, reply) => {
      const { orgId } = request.params as { orgId: string };
      const [org] = await app.db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, orgId));
      if (!org || (await callerRole(app, request, orgId)) === null) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "organization not found" });
      }
      const rows = await app.db
        .select({
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          role: memberships.role,
          joinedAt: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(users, eq(memberships.userId, users.id))
        .where(eq(memberships.organizationId, orgId))
        .orderBy(desc(memberships.createdAt));
      return rows;
    },
  );
};
