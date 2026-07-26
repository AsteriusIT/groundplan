/**
 * Acting on a ref event, wherever it came from (GP-194).
 *
 * The poller and the webhook are two `RefEventSource`s answering the same
 * question — "what moved?" — so they must not be two code paths. Both funnel
 * through `handleRefEvent`, which does exactly two things: refuse to act on a
 * fact it has already acted on, and dispatch.
 *
 * Deduplication is on the **fact** (repository + kind + branch + sha), not on
 * the delivery. A push that arrives by webhook and again on the poller's next
 * tick is one fact and one regeneration; a delivery GitHub retries is the same.
 * The unique index does the arbitration, so two concurrent deliveries cannot
 * both win — no lock, no queue (ADR #7).
 */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";

import {
  pullRequests,
  refEventDeliveries,
  repositories,
  type RepositoryRow,
} from "../db/schema.js";
import { isUniqueViolation } from "../lib/db-errors.js";
import type { RefEvent } from "../integrations/types.js";
import { closePullRequestsForBranch } from "./pull-requests.js";
import { regenerateDocsForSha } from "./repo-docs.js";

export type RefEventSourceName = "webhook" | "poller";

/**
 * Claim a fact for processing. `true` means this caller is the first to see it
 * and should act; `false` means somebody already did.
 */
async function claim(
  app: FastifyInstance,
  repositoryId: string,
  event: RefEvent,
  source: RefEventSourceName,
): Promise<boolean> {
  try {
    const inserted = await app.db
      .insert(refEventDeliveries)
      .values({
        repositoryId,
        kind: event.kind,
        branch: event.branch,
        sha: event.sha,
        source,
      })
      .onConflictDoNothing()
      .returning({ id: refEventDeliveries.id });
    return inserted.length > 0;
  } catch (err) {
    // A racing insert that beat the ON CONFLICT window is still "somebody else
    // has this", not a failure.
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

/**
 * Upsert the PullRequest row for a `pull_request` event. Same rule as the CI
 * webhook (GP-14): a closed PR is never re-opened, because git decides
 * existence and the poller owns closing.
 */
async function upsertPullRequest(
  app: FastifyInstance,
  repositoryId: string,
  event: RefEvent,
): Promise<void> {
  if (event.prNumber === undefined) return;
  const [existing] = await app.db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        eq(pullRequests.number, event.prNumber),
      ),
    );

  const now = new Date();
  const closed = event.prState === "closed";
  if (!existing) {
    await app.db.insert(pullRequests).values({
      repositoryId,
      number: event.prNumber,
      title: event.prTitle ?? null,
      state: closed ? "closed" : "open",
      closedAt: closed ? now : null,
      sourceRef: event.branch,
      latestCommitSha: event.sha,
    });
    return;
  }

  const closing = closed && existing.state === "open";
  await app.db
    .update(pullRequests)
    .set({
      sourceRef: event.branch,
      ...(event.sha ? { latestCommitSha: event.sha } : {}),
      updatedAt: now,
      ...(event.prTitle !== undefined ? { title: event.prTitle } : {}),
      ...(closing ? { state: "closed" as const, closedAt: now } : {}),
    })
    .where(eq(pullRequests.id, existing.id));
}

/**
 * React to one normalized ref event, once. What each kind means is the same as
 * it has always been (GP-107..109): the default branch moving regenerates the
 * living documentation, a deleted branch soft-closes its pull request, and a
 * feature branch moving is recorded but does nothing — its diagram comes from
 * the plan its CI pushes, not from the fact that it moved.
 *
 * Returns whether it acted, so a caller can report "accepted, 1 of 2 new".
 */
export async function handleRefEvent(
  app: FastifyInstance,
  repo: RepositoryRow,
  event: RefEvent,
  source: RefEventSourceName,
): Promise<boolean> {
  if (!(await claim(app, repo.id, event, source))) return false;

  app.log.info(
    { repositoryId: repo.id, kind: event.kind, branch: event.branch, source },
    "ref event",
  );

  switch (event.kind) {
    case "push":
      if (event.branch === repo.defaultBranch) {
        await regenerateDocsForSha(app, repo, event.sha);
      }
      break;
    case "branch_deleted":
      await closePullRequestsForBranch(app, repo, event.branch);
      break;
    case "pull_request":
      await upsertPullRequest(app, repo.id, event);
      break;
  }
  return true;
}

/**
 * Record that this repository is hearing from its provider (GP-194). It is what
 * lets the poller back off to a safety net; the timestamp is refreshed on every
 * accepted delivery, including ones that deduplicate to nothing — the point is
 * that the webhook is *alive*, not that it said something new.
 */
export async function markWebhookSeen(
  app: FastifyInstance,
  repositoryId: string,
): Promise<void> {
  await app.db
    .update(repositories)
    .set({ webhookSeenAt: new Date() })
    .where(eq(repositories.id, repositoryId));
}
