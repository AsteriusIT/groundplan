import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";

import { remoteRefs, repositories, type RepositoryRow } from "../db/schema.js";
import { listRemoteHeads } from "./repo-files.js";
import { regenerateDocsForSha } from "./repo-docs.js";
import { closePullRequestsForBranch } from "./pull-requests.js";

/**
 * The three git facts the poller reports (GP-107). `MainUpdated` is the default
 * branch moving; `BranchUpdated` is any other branch moving; `BranchDeleted` is a
 * branch that was there last tick and is gone now. A *new* branch appearing is
 * deliberately not an event — it is recorded, but nothing reacts to it (a branch
 * with no plan pushed to it has nothing to draw).
 */
export type GitEventType = "MainUpdated" | "BranchUpdated" | "BranchDeleted";

/** For a deletion, `sha` is the last sha we saw before the branch vanished. */
export type GitEvent = { type: GitEventType; branch: string; sha: string };

/**
 * Compare the last-known refs against a fresh `ls-remote`, purely. This is the
 * whole decision procedure of the poller, kept free of I/O so every rule — a new
 * branch is silent, `main` moving is `MainUpdated`, a gone branch is
 * `BranchDeleted` exactly once — is unit-testable without a git remote.
 *
 * `stored` and `remote` map short branch name → sha; `defaultBranch` is what
 * distinguishes `MainUpdated` from `BranchUpdated`.
 */
export function diffRefs(
  stored: Map<string, string>,
  remote: Map<string, string>,
  defaultBranch: string,
): GitEvent[] {
  const events: GitEvent[] = [];

  for (const [branch, sha] of remote) {
    const prev = stored.get(branch);
    // A brand-new branch is recorded (by the caller) but emits nothing: absence
    // of a prior sha is not a change, and branch *creation* triggers no work.
    if (prev === undefined) continue;
    if (prev !== sha) {
      events.push({
        type: branch === defaultBranch ? "MainUpdated" : "BranchUpdated",
        branch,
        sha,
      });
    }
  }

  for (const [branch, sha] of stored) {
    if (!remote.has(branch)) events.push({ type: "BranchDeleted", branch, sha });
  }

  return events;
}

/** Decrypt a repository's stored PAT, or null when there is none / it is bad. */
function decryptPat(app: FastifyInstance, repo: RepositoryRow): string | null {
  if (!repo.accessToken) return null;
  try {
    return app.encryptor.decrypt(repo.accessToken);
  } catch (err) {
    app.log.warn({ err, repositoryId: repo.id }, "could not decrypt stored PAT");
    return null;
  }
}

/**
 * Persist the new ref state: upsert every branch the remote reports, and delete
 * the rows for branches that are gone. Done only after a *successful* fetch, so a
 * failed tick never mutates state (and so never manufactures a `BranchDeleted`).
 */
async function persistRefs(
  app: FastifyInstance,
  repositoryId: string,
  stored: Map<string, string>,
  remote: Map<string, string>,
): Promise<void> {
  const now = new Date();
  for (const [refName, sha] of remote) {
    await app.db
      .insert(remoteRefs)
      .values({ repositoryId, refName, sha, lastSeenAt: now })
      .onConflictDoUpdate({
        target: [remoteRefs.repositoryId, remoteRefs.refName],
        set: { sha, lastSeenAt: now },
      });
  }
  for (const refName of stored.keys()) {
    if (remote.has(refName)) continue;
    await app.db
      .delete(remoteRefs)
      .where(
        and(eq(remoteRefs.repositoryId, repositoryId), eq(remoteRefs.refName, refName)),
      );
  }
}

/**
 * Poll one repository: `git ls-remote`, diff against the stored refs, persist the
 * new state, and return the events. On fetch failure it marks the repository's
 * `pollError`, leaves the stored refs untouched, and returns no events — the
 * absence of data is never read as "every branch was deleted".
 *
 * Persisting is idempotent by design: run twice on an unchanged remote and the
 * second run diffs equal and returns nothing, which is also why a service
 * restart replays no events.
 */
export async function pollRepository(
  app: FastifyInstance,
  repo: RepositoryRow,
): Promise<GitEvent[]> {
  const accessToken = decryptPat(app, repo);

  let remote: Map<string, string>;
  try {
    remote = await listRemoteHeads({
      url: repo.url,
      provider: repo.provider,
      accessToken,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    app.log.warn({ err, repositoryId: repo.id }, "ref poll ls-remote failed");
    await app.db
      .update(repositories)
      .set({ pollError: message, lastPolledAt: new Date() })
      .where(eq(repositories.id, repo.id));
    return [];
  }

  const storedRows = await app.db
    .select({ refName: remoteRefs.refName, sha: remoteRefs.sha })
    .from(remoteRefs)
    .where(eq(remoteRefs.repositoryId, repo.id));
  const stored = new Map(storedRows.map((r) => [r.refName, r.sha]));

  const events = diffRefs(stored, remote, repo.defaultBranch);
  await persistRefs(app, repo.id, stored, remote);
  await app.db
    .update(repositories)
    .set({ pollError: null, lastPolledAt: new Date() })
    .where(eq(repositories.id, repo.id));

  return events;
}

/**
 * Poll every repository, sequentially (ADR #7 — no queue, no workers), and
 * dispatch each event to its handler. One repository's failure never stops the
 * others: it is logged and the loop moves on.
 */
export async function pollAllRepositories(app: FastifyInstance): Promise<void> {
  const repos = await app.db.select().from(repositories);
  for (const repo of repos) {
    try {
      const events = await pollRepository(app, repo);
      for (const event of events) await dispatchGitEvent(app, repo, event);
    } catch (err) {
      app.log.error({ err, repositoryId: repo.id }, "ref poll failed for repository");
    }
  }
}

/**
 * React to one git event. The poller only *reports*; what a report means is
 * decided here.
 *
 * - `MainUpdated` regenerates the docs snapshot of `main` for the new sha
 *   (GP-108) — living documentation with no webhook and no user action.
 * - `BranchUpdated` is recorded but does nothing yet: a branch's diagram comes
 *   from the plan its CI pushes (GP-13), not from the poller.
 * - `BranchDeleted` soft-closes the branch's pull request (GP-109).
 *
 * Runs synchronously within the poll tick (ADR #7): a snapshot takes seconds,
 * and serialising it behind polling is fine at current scale.
 */
export async function dispatchGitEvent(
  app: FastifyInstance,
  repo: RepositoryRow,
  event: GitEvent,
): Promise<void> {
  app.log.info(
    { repositoryId: repo.id, event: event.type, branch: event.branch },
    "git event",
  );
  switch (event.type) {
    case "MainUpdated":
      await regenerateDocsForSha(app, repo, event.sha);
      break;
    case "BranchUpdated":
      break;
    case "BranchDeleted":
      await closePullRequestsForBranch(app, repo, event.branch);
      break;
  }
}
