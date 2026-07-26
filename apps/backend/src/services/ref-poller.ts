import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";

import { remoteRefs, repositories, type RepositoryRow } from "../db/schema.js";
import { repositoryAccessToken } from "../integrations/credentials.js";
import type { RefEvent } from "../integrations/types.js";
import { listRemoteHeads } from "./repo-files.js";
import { handleRefEvent } from "./ref-events.js";

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

/**
 * The token that authenticates this repository, or null (GP-192). Whether it
 * came from a pasted PAT, a GitHub App installation or an OAuth connection is
 * the strategy layer's business; a revoked connection is reported as a poll
 * error, exactly like an unreachable host — the poller degrades, never crashes.
 */
async function pollToken(
  app: FastifyInstance,
  repo: RepositoryRow,
): Promise<{ token: string | null; error: string | null }> {
  try {
    const credential = await repositoryAccessToken(app, repo);
    return { token: credential?.token ?? null, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    app.log.warn({ err, repositoryId: repo.id }, "could not obtain a repository token");
    return { token: null, error: message };
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
  const { token: accessToken, error: credentialError } = await pollToken(app, repo);
  if (credentialError) {
    // A credential we cannot use is not "no branches": record it and stop, the
    // same shape as a failed fetch, so no `BranchDeleted` is ever manufactured.
    await app.db
      .update(repositories)
      .set({ pollError: credentialError, lastPolledAt: new Date() })
      .where(eq(repositories.id, repo.id));
    return [];
  }

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
 * How long a webhook delivery keeps a repository "live" (GP-194). Inside this
 * window the poller is a safety net rather than the source: it still runs, but
 * rarely, so a lost delivery is caught within the window instead of never.
 */
const WEBHOOK_QUIET_MS = 15 * 60 * 1000;

/**
 * Should this tick skip a repository? Only when its provider is delivering
 * webhooks *and* we polled it recently — so the very first tick after a quiet
 * period always runs, and a repository whose webhook silently stopped is back
 * to full polling within one window.
 */
export function shouldSkipPoll(repo: RepositoryRow, nowMs: number): boolean {
  if (!repo.webhookSeenAt) return false; // no webhooks here — poll as always
  if (nowMs - repo.webhookSeenAt.getTime() > WEBHOOK_QUIET_MS) return false;
  const lastPolled = repo.lastPolledAt?.getTime();
  return lastPolled !== undefined && nowMs - lastPolled < WEBHOOK_QUIET_MS;
}

/**
 * Poll every repository, sequentially (ADR #7 — no queue, no workers), and
 * dispatch each event to its handler. One repository's failure never stops the
 * others: it is logged and the loop moves on.
 *
 * A repository hearing from its provider (GP-194) is polled at the safety-net
 * cadence instead of every tick — and the events it does find go through the
 * same deduplicating handler the webhook uses, so nothing is done twice.
 */
export async function pollAllRepositories(app: FastifyInstance): Promise<void> {
  const repos = await app.db.select().from(repositories);
  const now = Date.now();
  for (const repo of repos) {
    if (shouldSkipPoll(repo, now)) continue;
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
  // Through the shared handler (GP-194), so a fact the webhook already acted on
  // is not acted on again when the poller happens to see it too.
  await handleRefEvent(app, repo, toRefEvent(event), "poller");
}

/**
 * The poller's vocabulary in the shared one. `BranchUpdated` maps to a `push`
 * like `MainUpdated` does — what makes main special is the *handler*, which
 * compares the branch to the repository's default, not the event name.
 */
function toRefEvent(event: GitEvent): RefEvent {
  if (event.type === "BranchDeleted") {
    return {
      kind: "branch_deleted",
      branch: event.branch,
      sha: event.sha,
      remoteUrl: null,
    };
  }
  return { kind: "push", branch: event.branch, sha: event.sha, remoteUrl: null };
}
