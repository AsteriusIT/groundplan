/**
 * PrCommentPort (GP-53): the provider-agnostic seam for the PR summary comment.
 *
 * GP-38 hard-wired GitHub. This extracts a single `upsertComment` operation so
 * each provider (GitHub, GitLab, Azure DevOps) supplies its own idempotent
 * post-or-update behind the same interface. Idempotence is uniform: find the one
 * comment carrying the hidden marker and update it, otherwise create a new one.
 */
import { parseGitHubRepo, type GitHubClient } from "./github.js";
import { parseGitLabRepo, type GitLabClient } from "./gitlab.js";

export interface UpsertCommentArgs {
  /** The repository URL — each port parses out the identifiers it needs. */
  repoUrl: string;
  /** PR / MR number (GitLab MR iid). */
  prNumber: number;
  /** Hidden marker identifying our comment, for idempotent updates. */
  marker: string;
  /** Full Markdown body (already leads with the marker). */
  body: string;
  /** Decrypted PAT. */
  token: string;
}

export interface PrCommentPort {
  /** Create our comment, or update the existing marked one in place. */
  upsertComment(args: UpsertCommentArgs): Promise<void>;
}

/** GitHub PR comments — the GP-38 behaviour, now behind the port. */
export function createGitHubPort(client: GitHubClient): PrCommentPort {
  return {
    async upsertComment({ repoUrl, prNumber, marker, body, token }) {
      const target = parseGitHubRepo(repoUrl);
      if (!target) throw new Error(`not a GitHub repository URL: ${repoUrl}`);
      const comments = await client.listIssueComments(
        target.owner,
        target.repo,
        prNumber,
        token,
      );
      const existing = comments.find((c) => c.body.includes(marker));
      if (existing) {
        await client.updateIssueComment(target.owner, target.repo, existing.id, body, token);
      } else {
        await client.createIssueComment(target.owner, target.repo, prNumber, body, token);
      }
    },
  };
}

/** GitLab merge-request notes (cloud + self-hosted). */
export function createGitLabPort(client: GitLabClient): PrCommentPort {
  return {
    async upsertComment({ repoUrl, prNumber, marker, body, token }) {
      const target = parseGitLabRepo(repoUrl);
      if (!target) throw new Error(`not a GitLab repository URL: ${repoUrl}`);
      const notes = await client.listMergeRequestNotes(
        target.apiBase,
        target.projectPath,
        prNumber,
        token,
      );
      const existing = notes.find((n) => n.body.includes(marker));
      if (existing) {
        await client.updateMergeRequestNote(
          target.apiBase,
          target.projectPath,
          prNumber,
          existing.id,
          body,
          token,
        );
      } else {
        await client.createMergeRequestNote(
          target.apiBase,
          target.projectPath,
          prNumber,
          body,
          token,
        );
      }
    },
  };
}
