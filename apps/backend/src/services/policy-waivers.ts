/**
 * GP-204: waivers — storing them, tracing what was done to them, and keeping
 * them anchored to resources that still exist.
 *
 * Every write goes through here so every write leaves a trail: creating,
 * extending and revoking each append an event, and revoking never deletes the
 * row. That trail is the base of the audit log the product will want, and it is
 * the reason an exemption is safe to grant — somebody can always ask who
 * suspended what, when, and why.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, asc, desc, eq, isNull } from "drizzle-orm";

import {
  policyWaiverEvents,
  policyWaivers,
  type PolicyWaiverEventRow,
  type PolicyWaiverRow,
} from "../db/schema.js";
import { ruleById } from "../graph/policy/catalog.js";
import { reconcileWaivers } from "../graph/policy/waivers.js";
import type { Graph } from "../graph/graph.js";

/** Live (non-revoked) waivers of a repository, oldest first. */
export async function listWaivers(
  db: NodePgDatabase,
  repositoryId: string,
): Promise<PolicyWaiverRow[]> {
  return db
    .select()
    .from(policyWaivers)
    .where(
      and(
        eq(policyWaivers.repositoryId, repositoryId),
        isNull(policyWaivers.revokedAt),
      ),
    )
    .orderBy(asc(policyWaivers.createdAt));
}

/** The trail: what was done to this repository's waivers, newest first. */
export async function listWaiverEvents(
  db: NodePgDatabase,
  repositoryId: string,
): Promise<PolicyWaiverEventRow[]> {
  return db
    .select()
    .from(policyWaiverEvents)
    .where(eq(policyWaiverEvents.repositoryId, repositoryId))
    .orderBy(desc(policyWaiverEvents.createdAt));
}

export class WaiverRuleUnknownError extends Error {
  constructor(ruleId: string) {
    super(`unknown policy rule: ${ruleId}`);
    this.name = "WaiverRuleUnknownError";
  }
}

export class WaiverExistsError extends Error {
  constructor() {
    super("this rule is already waived on this resource");
    this.name = "WaiverExistsError";
  }
}

export type CreateWaiverInput = {
  repositoryId: string;
  ruleId: string;
  address: string;
  reason: string;
  expiresAt: Date | null;
  actorId: string | null;
};

/**
 * Grant an exemption. The reason is mandatory at the route's schema *and* here:
 * it is the only thing that makes a waiver reviewable later, and a blank one
 * would turn the trail into a list of shrugs.
 */
export async function createWaiver(
  db: NodePgDatabase,
  input: CreateWaiverInput,
): Promise<PolicyWaiverRow> {
  if (!ruleById(input.ruleId)) throw new WaiverRuleUnknownError(input.ruleId);

  const [existing] = await db
    .select({ id: policyWaivers.id })
    .from(policyWaivers)
    .where(
      and(
        eq(policyWaivers.repositoryId, input.repositoryId),
        eq(policyWaivers.ruleId, input.ruleId),
        eq(policyWaivers.address, input.address),
        isNull(policyWaivers.revokedAt),
      ),
    );
  if (existing) throw new WaiverExistsError();

  const [row] = await db
    .insert(policyWaivers)
    .values({
      repositoryId: input.repositoryId,
      ruleId: input.ruleId,
      address: input.address,
      reason: input.reason,
      expiresAt: input.expiresAt,
      createdBy: input.actorId,
    })
    .returning();

  const waiver = row as PolicyWaiverRow;
  await db.insert(policyWaiverEvents).values({
    waiverId: waiver.id,
    repositoryId: waiver.repositoryId,
    action: "created",
    reason: waiver.reason,
    expiresAt: waiver.expiresAt,
    actorId: input.actorId,
  });
  return waiver;
}

/**
 * Move a waiver's end date, or restate why it exists. Traced as an `extended`
 * event whichever way the date moves — "extended" is what this action is called
 * in the trail, and shortening one is the same decision made in the other
 * direction.
 */
export async function extendWaiver(
  db: NodePgDatabase,
  id: string,
  patch: { expiresAt?: Date | null; reason?: string },
  actorId: string | null,
): Promise<PolicyWaiverRow | null> {
  const [existing] = await db
    .select()
    .from(policyWaivers)
    .where(eq(policyWaivers.id, id));
  if (!existing || existing.revokedAt) return null;

  const [row] = await db
    .update(policyWaivers)
    .set({
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
      updatedAt: new Date(),
    })
    .where(eq(policyWaivers.id, id))
    .returning();

  const waiver = row as PolicyWaiverRow;
  await db.insert(policyWaiverEvents).values({
    waiverId: waiver.id,
    repositoryId: waiver.repositoryId,
    action: "extended",
    reason: waiver.reason,
    expiresAt: waiver.expiresAt,
    actorId,
  });
  return waiver;
}

/** Withdraw a waiver. The row stays — the trail refers to it. */
export async function revokeWaiver(
  db: NodePgDatabase,
  id: string,
  actorId: string | null,
): Promise<PolicyWaiverRow | null> {
  const [existing] = await db
    .select()
    .from(policyWaivers)
    .where(eq(policyWaivers.id, id));
  if (!existing || existing.revokedAt) return null;

  const [row] = await db
    .update(policyWaivers)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(policyWaivers.id, id))
    .returning();

  const waiver = row as PolicyWaiverRow;
  await db.insert(policyWaiverEvents).values({
    waiverId: waiver.id,
    repositoryId: waiver.repositoryId,
    action: "revoked",
    reason: waiver.reason,
    expiresAt: waiver.expiresAt,
    actorId,
  });
  return waiver;
}

/**
 * Reconcile a repository's waivers against a freshly generated graph — the
 * annotation layer's post-step, applied to exemptions (GP-57/GP-204). Only rows
 * whose status actually changed are written. Returns how many moved.
 */
export async function reconcileRepositoryWaivers(
  db: NodePgDatabase,
  repositoryId: string,
  graph: Graph,
): Promise<number> {
  const rows = await listWaivers(db, repositoryId);
  const addresses = new Set(graph.nodes.map((n) => n.id));
  const results = reconcileWaivers(rows, addresses);
  const byId = new Map(rows.map((r) => [r.id, r]));

  let updated = 0;
  for (const result of results) {
    if (byId.get(result.id)?.status === result.status) continue;
    await db
      .update(policyWaivers)
      .set({ status: result.status, updatedAt: new Date() })
      .where(eq(policyWaivers.id, result.id));
    updated += 1;
  }
  return updated;
}
