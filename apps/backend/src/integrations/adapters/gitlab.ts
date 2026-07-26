/**
 * The GitLab adapter (GP-192): hosts, clone username and the idempotent MR note
 * (GP-53's behaviour, moved behind the port).
 *
 * Only `gitlab.com` is claimed by host. A self-managed instance is any hostname
 * at all, so it cannot be detected — the user picks the provider at attach time
 * (or connects a GitLab OAuth app, GP-195, which names its instance).
 */
import { parseGitLabRepo, type GitLabClient } from "../../services/gitlab.js";
import { defineProvider } from "../provider.js";
import { gitlabRefEvents } from "../webhooks.js";
import type {
  IntegrationProvider,
  PullRequestCommenter,
  RepoReader,
} from "../types.js";

/** `oauth2` is GitLab's documented username for both a PAT and an OAuth token. */
const repo: RepoReader = {
  cloneUsername: () => "oauth2",
};

export function createGitLabCommenter(client: GitLabClient): PullRequestCommenter {
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

export function createGitLabProvider(client: GitLabClient): IntegrationProvider {
  return defineProvider({
    id: "gitlab",
    label: "GitLab",
    credentialModes: ["oauth2", "pat"],
    hosts: ["gitlab.com"],
    repo,
    commenter: createGitLabCommenter(client),
    refEvents: gitlabRefEvents,
  });
}
