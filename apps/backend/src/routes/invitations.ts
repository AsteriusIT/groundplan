/**
 * Organization invitations (GP-116). An admin/owner mints a single-use, expiring
 * link (no SMTP — the API returns the URL, the frontend offers a copy button);
 * the invitee accepts it after logging in and gains a membership.
 *
 * Two surfaces:
 *   - management, org-scoped under `/orgs/:orgId/invitations` (admin+), and
 *   - acceptance, a global authenticated `POST /invitations/accept` — the invitee
 *     is not a member yet, so it cannot live behind the org guard.
 */
import type { FastifyPluginAsync } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";

import {
  invitations,
  memberships,
  organizations,
  toPublicInvitation,
} from "../db/schema.js";
import { generateToken, hashToken } from "../lib/tokens.js";
import { orgIdOf, requirePermission } from "../rbac/request.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/** Invitations last a week (GP-116). */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
};

const createInviteSchema = {
  type: "object",
  required: ["role"],
  additionalProperties: false,
  properties: {
    // owner is intentionally absent — ownership transfer is an org-settings action.
    role: { type: "string", enum: ["admin", "member"] },
    email: { type: "string", maxLength: 320 },
  },
};

const acceptSchema = {
  type: "object",
  required: ["token"],
  additionalProperties: false,
  properties: { token: { type: "string", pattern: "^[A-Za-z0-9_-]{16,128}$" } },
};

/** Org-scoped invite management (admin+): create, list, revoke. */
export const invitationRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/invitations",
    { schema: { body: createInviteSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "member:manage")) return reply;
      // Single-org mode auto-joins everyone to the one org, so invites are moot.
      if (app.singleOrg) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "invitations are disabled in single-org mode",
        });
      }
      const { role, email } = request.body as {
        role: "admin" | "member";
        email?: string;
      };

      const token = generateToken();
      const [row] = await app.db
        .insert(invitations)
        .values({
          organizationId: orgIdOf(request),
          email: email ?? null,
          role,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          createdBy: request.authUser?.id ?? null,
        })
        .returning();

      // The token (and a ready-made URL when a public base is configured) is
      // shown ONCE here; every later read masks it (toPublicInvitation omits it).
      const url = app.publicBaseUrl
        ? `${app.publicBaseUrl}/invite/${token}`
        : null;
      return reply.code(201).send({ ...toPublicInvitation(row!), token, url });
    },
  );

  app.get("/invitations", async (request, reply) => {
    if (!requirePermission(request, reply, "member:manage")) return reply;
    const rows = await app.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.organizationId, orgIdOf(request)),
          isNull(invitations.acceptedAt),
        ),
      )
      .orderBy(desc(invitations.createdAt));
    return rows.map(toPublicInvitation);
  });

  app.delete(
    "/invitations/:id",
    { schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!requirePermission(request, reply, "member:manage")) return reply;
      const { id } = request.params as { id: string };
      const deleted = await app.db
        .delete(invitations)
        .where(eq(invitations.id, id))
        .returning({ id: invitations.id });
      if (deleted.length === 0) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "invitation not found" });
      }
      return reply.code(204).send();
    },
  );
};

/**
 * Accept an invitation (global, authenticated). The logged-in user redeems the
 * token and gains the membership. Consuming the invite is atomic (UPDATE ... WHERE
 * accepted_at IS NULL), so a second accept, an expired token or a revoked one all
 * fail with a clear 4xx. An invitee who is already a member gets a no-op — the
 * invite is spent but their role is never escalated.
 */
export const invitationAcceptRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/invitations/accept",
    { schema: { body: acceptSchema } },
    async (request, reply) => {
      const user = request.authUser;
      if (!user) {
        return reply
          .code(401)
          .send({ error: "Unauthorized", message: "not authenticated" });
      }
      const { token } = request.body as { token: string };

      const [invite] = await app.db
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, hashToken(token)));
      if (!invite) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "invalid invitation" });
      }
      if (invite.acceptedAt) {
        return reply.code(409).send({
          error: "Conflict",
          message: "this invitation has already been accepted",
        });
      }
      if (invite.expiresAt.getTime() <= Date.now()) {
        return reply
          .code(410)
          .send({ error: "Gone", message: "this invitation has expired" });
      }

      // Consume it atomically: whoever flips accepted_at first wins the race.
      const [consumed] = await app.db
        .update(invitations)
        .set({ acceptedAt: new Date(), acceptedBy: user.id })
        .where(
          and(eq(invitations.id, invite.id), isNull(invitations.acceptedAt)),
        )
        .returning({ id: invitations.id });
      if (!consumed) {
        return reply.code(409).send({
          error: "Conflict",
          message: "this invitation has already been accepted",
        });
      }

      // Grant the membership — but never escalate an existing member's role.
      await app.db
        .insert(memberships)
        .values({
          userId: user.id,
          organizationId: invite.organizationId,
          role: invite.role,
        })
        .onConflictDoNothing({
          target: [memberships.userId, memberships.organizationId],
        });

      const [org] = await app.db
        .select({
          id: organizations.id,
          name: organizations.name,
          slug: organizations.slug,
        })
        .from(organizations)
        .where(eq(organizations.id, invite.organizationId));
      return reply.code(200).send({ organization: org });
    },
  );
};
