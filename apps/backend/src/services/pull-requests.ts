import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";

import { pullRequests, type RepositoryRow } from "../db/schema.js";

/**
 * The short branch name a PR's `sourceRef` points at (GP-109). The CLI (GP-110)
 * sends the head branch verbatim; a webhook that sent `refs/heads/x` is
 * normalized to `x` so it matches the poller's short branch names either way.
 */
export function branchOf(ref: string): string {
  const prefix = "refs/heads/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

/**
 * Soft-close every OPEN pull request whose branch is `branch` (GP-109), stamping
 * `closedAt`. Called from the poller's `BranchDeleted` — git decides existence,
 * so when a branch is gone its PR is closed. Snapshots and diagrams are kept, so
 * the past stays viewable; only the PR's *state* changes.
 *
 * One-directional and idempotent: it only ever touches rows still `open`, so a PR
 * already closed is a no-op and repeated ticks close nothing twice. A branch with
 * no matching open PR (never had one, or already closed) is also a no-op.
 * Returns how many PRs it closed.
 */
export async function closePullRequestsForBranch(
  app: FastifyInstance,
  repo: RepositoryRow,
  branch: string,
): Promise<number> {
  const open = await app.db
    .select()
    .from(pullRequests)
    .where(
      and(eq(pullRequests.repositoryId, repo.id), eq(pullRequests.state, "open")),
    );
  const matches = open.filter((pr) => branchOf(pr.sourceRef) === branch);

  const now = new Date();
  for (const pr of matches) {
    await app.db
      .update(pullRequests)
      .set({ state: "closed", closedAt: now, updatedAt: now })
      .where(eq(pullRequests.id, pr.id));
  }
  return matches.length;
}
