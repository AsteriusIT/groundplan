/**
 * First-login onboarding (GP-115). In single-org (self-hosted) mode a freshly
 * provisioned user must land in a coherent state: a member of the one org. The
 * very first user ever becomes its `owner`; everyone after is a `member`.
 *
 * This runs from the JIT provisioning hook (GP-6). It is idempotent — a user who
 * already has a membership in the default org is left exactly as they are, so a
 * later role change (e.g. promotion to admin) is never overwritten.
 */
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { memberships, organizations } from "../db/schema.js";
import type { Role } from "../rbac/permissions.js";

/** The seeded org every single-org deployment shares (created by migration 0029). */
export const DEFAULT_ORG_SLUG = "default";

/**
 * The role a brand-new member of an org should get: `owner` if the org has no
 * members yet (the first user ever), otherwise `member`.
 */
export async function roleForNewMember(
  db: NodePgDatabase,
  organizationId: string,
): Promise<Role> {
  const [existing] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.organizationId, organizationId))
    .limit(1);
  return existing ? "member" : "owner";
}

/**
 * Ensure a single-org user belongs to the default org. No-op if they already do,
 * or if there is no default org. Returns the membership role in effect (or null
 * when there is no default org to join).
 */
export async function ensureOnboarded(
  db: NodePgDatabase,
  userId: string,
): Promise<Role | null> {
  const [defaultOrg] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, DEFAULT_ORG_SLUG));
  if (!defaultOrg) return null;

  const [current] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        eq(memberships.organizationId, defaultOrg.id),
      ),
    );
  if (current) return current.role;

  const role = await roleForNewMember(db, defaultOrg.id);
  // ON CONFLICT DO NOTHING guards the race where two first-requests interleave.
  await db
    .insert(memberships)
    .values({ userId, organizationId: defaultOrg.id, role })
    .onConflictDoNothing({
      target: [memberships.userId, memberships.organizationId],
    });
  return role;
}

/**
 * The caller's memberships (org identity + role), for `GET /me` (GP-115) so the
 * frontend can route onboarding and switch orgs without extra calls. Uses a raw
 * jsonb-friendly shape the route serialises directly.
 */
export async function membershipsFor(db: NodePgDatabase, userId: string) {
  return db
    .select({
      role: memberships.role,
      organization: sql<{
        id: string;
        name: string;
        slug: string;
      }>`json_build_object('id', ${organizations.id}, 'name', ${organizations.name}, 'slug', ${organizations.slug})`,
    })
    .from(memberships)
    .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
    .where(eq(memberships.userId, userId))
    .orderBy(organizations.createdAt);
}
