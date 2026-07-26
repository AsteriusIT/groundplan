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
import { repositoryAccessToken } from "../integrations/credentials.js";
import { CredentialRevokedError } from "../integrations/types.js";
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
  // Only a plan snapshot from a repository's CI has a pull request to comment on.
  if (snapshot.prNumber === null || snapshot.repositoryId === null) return;

  const [repo] = await app.db
    .select()
    .from(repositories)
    .where(eq(repositories.id, snapshot.repositoryId));
  if (!repo?.prCommentsEnabled) return; // flag off → zero provider calls

  // Feature detection, not a provider check (GP-192): a provider that declares
  // no `pr:comment` capability has no commenter, and that is the whole branch.
  const provider = app.providers.get(repo.provider);
  const commenter = provider.commenter;
  if (!commenter) {
    // generic / self-hosted-only host: surface it instead of failing silently.
    await setLastCommentError(
      app,
      repo.id,
      `PR comments are not available for ${provider.label} repositories`,
    );
    return;
  }

  // Whatever authenticates this repository — a pasted PAT, an App installation,
  // an OAuth connection — arrives here as a token and nothing else (GP-192).
  let token: string;
  try {
    const credential = await repositoryAccessToken(app, repo);
    if (!credential) {
      await setLastCommentError(app, repo.id, "no access token configured");
      return;
    }
    token = credential.token;
  } catch (err) {
    const message =
      err instanceof CredentialRevokedError
        ? `${err.message} — reconnect this integration`
        : "could not obtain an access token for this repository";
    await setLastCommentError(app, repo.id, message);
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
    await commenter.upsertComment({
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
