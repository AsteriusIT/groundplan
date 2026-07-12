/**
 * GP-38: post/update a single GitHub PR comment for a plan snapshot. Runs after
 * a PR plan snapshot is produced (same hook point as parsing), in the
 * background — it must never break ingestion. Idempotent via a hidden marker:
 * the comment is created once and updated in place on every push.
 *
 * Gated by the per-repository `pr_comments_enabled` flag (off by default → zero
 * GitHub calls). Any failure (bad PAT scope, rate limit, …) is recorded on the
 * repository (`last_comment_error`) and swallowed.
 */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { repositories, type GraphSnapshotRow } from "../db/schema.js";
import type { Provider } from "./providers.js";
import {
  createGitHubPort,
  createGitLabPort,
  type PrCommentPort,
} from "./pr-comment-port.js";
import { repoLabel } from "./snapshot-export.js";
import { ensureSnapshotShareLink } from "./share-links.js";

/** Hidden HTML marker that identifies our comment for idempotent updates. */
export const COMMENT_MARKER = "<!-- groundplan:comment -->";

const shortSha = (sha: string): string => sha.slice(0, 8);

export interface CommentBodyInput {
  repoLabel: string;
  ref: string;
  commitSha: string;
  summaryMd: string;
  /** Public image URL (PNG) to embed, or null for a stats-only comment. */
  imageUrl: string | null;
  /** Public "view interactive diagram" link, or null. */
  viewUrl: string | null;
}

/** Build the Markdown comment body (leads with the marker for idempotency). */
export function buildCommentBody(input: CommentBodyInput): string {
  const lines: string[] = [
    COMMENT_MARKER,
    "## 🗺 GroundPlan · infrastructure preview",
    "",
    `**${input.repoLabel}** · \`${shortSha(input.commitSha)}\` · \`${input.ref}\``,
    "",
    input.summaryMd,
  ];
  if (input.imageUrl) {
    lines.push("", `![Infrastructure change diagram](${input.imageUrl})`);
  }
  if (input.viewUrl) {
    lines.push("", `[View interactive diagram →](${input.viewUrl})`);
  }
  return lines.join("\n");
}

/**
 * Pick the PR-comment adapter for a repository's provider, or null when the
 * provider has no comment support (generic hosts; Azure DevOps until GP-54).
 */
function resolvePort(app: FastifyInstance, provider: Provider): PrCommentPort | null {
  switch (provider) {
    case "github":
      return createGitHubPort(app.github);
    case "gitlab":
      return createGitLabPort(app.gitlab);
    default:
      return null;
  }
}

/** Persist (or clear) the repository's last PR-comment error. */
async function setLastCommentError(
  app: FastifyInstance,
  repositoryId: string,
  message: string | null,
): Promise<void> {
  await app.db
    .update(repositories)
    .set({ lastCommentError: message })
    .where(eq(repositories.id, repositoryId));
}

/**
 * Post or update the GitHub PR comment for a plan snapshot. No-op unless the
 * snapshot is tied to a PR and the repository has PR comments enabled.
 */
export async function postPrComment(
  app: FastifyInstance,
  snapshot: GraphSnapshotRow,
): Promise<void> {
  if (snapshot.prNumber === null) return;

  const [repo] = await app.db
    .select()
    .from(repositories)
    .where(eq(repositories.id, snapshot.repositoryId));
  if (!repo || !repo.prCommentsEnabled) return; // flag off → zero provider calls

  const port = resolvePort(app, repo.provider);
  if (!port) {
    // generic / self-hosted-only host: surface it instead of failing silently.
    await setLastCommentError(
      app,
      repo.id,
      `PR comments are not available for ${repo.provider} repositories`,
    );
    return;
  }

  if (!repo.accessToken) {
    await setLastCommentError(app, repo.id, "no access token configured");
    return;
  }

  let token: string;
  try {
    token = app.encryptor.decrypt(repo.accessToken);
  } catch {
    await setLastCommentError(app, repo.id, "could not decrypt access token");
    return;
  }

  // Build the public image + view link when a public base URL is configured
  // (GP-39 share token). Without one, fall back to a stats + summary comment.
  let imageUrl: string | null = null;
  let viewUrl: string | null = null;
  if (app.publicBaseUrl) {
    const shareToken = await ensureSnapshotShareLink(app.db, repo.id, snapshot.id);
    imageUrl = `${app.publicBaseUrl}/api/v1/public/${shareToken}/export.png?scope=changes`;
    viewUrl = `${app.publicBaseUrl}/share/${shareToken}`;
  }

  const body = buildCommentBody({
    repoLabel: repoLabel(repo.url),
    ref: snapshot.ref,
    commitSha: snapshot.commitSha,
    summaryMd: snapshot.summaryMd,
    imageUrl,
    viewUrl,
  });

  try {
    await port.upsertComment({
      repoUrl: repo.url,
      prNumber: snapshot.prNumber,
      marker: COMMENT_MARKER,
      body,
      token,
    });
    if (repo.lastCommentError) await setLastCommentError(app, repo.id, null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    app.log.error({ err, repositoryId: repo.id, prNumber: snapshot.prNumber }, "PR comment failed");
    await setLastCommentError(app, repo.id, message);
  }
}
