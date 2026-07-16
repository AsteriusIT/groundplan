/**
 * Organization member management (GP-118). Org-scoped, so the guard has already
 * established the caller's membership and 404'd non-members. Reading the roster
 * is open to any member; changing a role or removing someone is admin+, with two
 * extra rules:
 *   - touching an *owner* (making one, changing one, removing one) requires
 *     owner — it is an ownership transfer, not routine member management;
 *   - the last owner can never be demoted or removed, so an org is never left
 *     without one (enforced here, not just in the UI).
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { and, count, desc, eq } from "drizzle-orm";

import { memberRole, memberships, users } from "../db/schema.js";
import { orgIdOf, requirePermission } from "../rbac/request.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const userIdParamsSchema = {
  type: "object",
  required: ["userId"],
  additionalProperties: false,
  properties: { userId: { type: "string", pattern: UUID_PATTERN } },
};

const changeRoleSchema = {
  type: "object",
  required: ["role"],
  additionalProperties: false,
  properties: { role: { type: "string", enum: [...memberRole.enumValues] } },
};

type Role = (typeof memberRole.enumValues)[number];

/** The API shape of a member row (name, email, role, joined date). */
function memberColumns() {
  return {
    userId: users.id,
    email: users.email,
    displayName: users.displayName,
    role: memberships.role,
    joinedAt: memberships.createdAt,
  };
}

async function loadMember(app: FastifyInstance, orgId: string, userId: string) {
  const [row] = await app.db
    .select(memberColumns())
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(
      and(
        eq(memberships.organizationId, orgId),
        eq(memberships.userId, userId),
      ),
    );
  return row;
}

async function ownerCount(app: FastifyInstance, orgId: string): Promise<number> {
  const [row] = await app.db
    .select({ n: count() })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, orgId),
        eq(memberships.role, "owner"),
      ),
    );
  return row?.n ?? 0;
}

/** The permission required to act on a member with (current, next) roles. */
function requiredPermission(
  currentRole: Role,
  nextRole?: Role,
): "member:manage" | "ownership:transfer" {
  return currentRole === "owner" || nextRole === "owner"
    ? "ownership:transfer"
    : "member:manage";
}

export const memberRoutes: FastifyPluginAsync = async (app) => {
  // The roster — readable by any member (the guard already proved membership).
  app.get("/members", async (request) => {
    return app.db
      .select(memberColumns())
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.organizationId, orgIdOf(request)))
      .orderBy(desc(memberships.createdAt));
  });

  app.patch(
    "/members/:userId",
    { schema: { params: userIdParamsSchema, body: changeRoleSchema } },
    async (request, reply) => {
      const orgId = orgIdOf(request);
      const { userId } = request.params as { userId: string };
      const { role: nextRole } = request.body as { role: Role };

      const target = await loadMember(app, orgId, userId);
      if (!target) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "member not found" });
      }

      if (!requirePermission(request, reply, requiredPermission(target.role, nextRole))) {
        return reply;
      }

      // Never leave the org without an owner.
      if (target.role === "owner" && nextRole !== "owner") {
        if ((await ownerCount(app, orgId)) <= 1) {
          return reply.code(400).send({
            error: "Bad Request",
            message: "cannot demote the last owner",
          });
        }
      }

      if (nextRole === target.role) return target; // no-op

      const [updated] = await app.db
        .update(memberships)
        .set({ role: nextRole })
        .where(
          and(
            eq(memberships.organizationId, orgId),
            eq(memberships.userId, userId),
          ),
        )
        .returning();
      return { ...target, role: updated!.role };
    },
  );

  app.delete(
    "/members/:userId",
    { schema: { params: userIdParamsSchema } },
    async (request, reply) => {
      const orgId = orgIdOf(request);
      const { userId } = request.params as { userId: string };

      const target = await loadMember(app, orgId, userId);
      if (!target) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "member not found" });
      }

      if (!requirePermission(request, reply, requiredPermission(target.role))) {
        return reply;
      }

      if (target.role === "owner" && (await ownerCount(app, orgId)) <= 1) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "cannot remove the last owner",
        });
      }

      await app.db
        .delete(memberships)
        .where(
          and(
            eq(memberships.organizationId, orgId),
            eq(memberships.userId, userId),
          ),
        );
      return reply.code(204).send();
    },
  );
};
