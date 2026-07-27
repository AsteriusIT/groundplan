/**
 * The GitLab adapter (GP-192): hosts, clone username and the idempotent MR note
 * (GP-53's behaviour, moved behind the port).
 *
 * Only `gitlab.com` is claimed by host. A self-managed instance is any hostname
 * at all, so it cannot be detected — the user picks the provider at attach time
 * (or connects a GitLab OAuth app, GP-195, which names its instance).
 */
import {
  GitLabApiError,
  parseGitLabRepo,
  type GitLabClient,
  type GitLabProject,
} from "../../services/gitlab.js";
import type { IntegrationsConfig } from "../config.js";
import type { OAuth2Http } from "../oauth2.js";
import { defineProvider } from "../provider.js";
import { gitlabRefEvents } from "../webhooks.js";
import { DiscoveryError, toDiscoveryError } from "../types.js";
import type {
  ConnectFlow,
  DiscoveredRepo,
  DiscoveryConnection,
  IntegrationProvider,
  PullRequestCommenter,
  RepoDiscoverer,
  RepoReader,
  RepoTree,
  RepoTreeReader,
} from "../types.js";
import { gitlabConnectFlow } from "./gitlab-oauth.js";

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

/**
 * The API base for a connection, from the instance it was made on. A
 * self-managed GitLab therefore needs no code — the row remembers where it
 * leads, exactly as the OAuth strategy already relies on (GP-195).
 */
function apiBaseOf(connection: DiscoveryConnection): string {
  const base = connection.config.instanceUrl ?? "https://gitlab.com";
  return `${base.replace(/\/+$/, "")}/api/v4`;
}

/**
 * Discovery for a GitLab connection (GP-232).
 *
 * Worth being clear about what this lists: a 3LO token is a **user** token, so
 * `membership=true` returns the projects the authorizing account belongs to —
 * not an organization's perimeter the way a GitHub App installation does. The
 * capability is the same; the meaning is not, and the screen says so instead of
 * implying an org-wide scope it cannot deliver.
 *
 * The cursor is our own page number. GitLab hands out a `X-Next-Page` header
 * and we translate it, rather than letting a provider-controlled value travel
 * out to the browser and back.
 */
export function gitlabDiscoverer(client: GitLabClient): RepoDiscoverer {
  return {
    async listRepositories(connection, cursor) {
      const page = parseCursor(cursor);
      let token: string;
      try {
        ({ token } = await connection.credential.getToken());
      } catch (err) {
        throw toDiscoveryError(err);
      }

      let result;
      try {
        result = await client.listProjects(apiBaseOf(connection), token, page);
      } catch (err) {
        throw asDiscoveryError(err);
      }

      return {
        repos: result.projects.map(toDiscoveredRepo),
        nextCursor: result.nextPage === null ? null : String(result.nextPage),
      };
    },
  };
}

/** Reading a project's shape without cloning it (GP-228, for GitLab). */
export function createGitLabTreeReader(client: GitLabClient): RepoTreeReader {
  return {
    async readTree(connection, target) {
      const { token } = await connection.credential.getToken();
      const apiBase = apiBaseOf(connection);
      const projectPath = `${target.owner}/${target.name}`;
      const entries: RepoTree["entries"] = [];

      // GitLab paginates a tree where GitHub does not. Rather than walk a
      // monorepo to the end for a *pre-selection*, we read a bounded prefix and
      // report the rest as truncated — which forbids `high` confidence, exactly
      // as GitHub's own truncation flag does.
      let page = 1;
      let truncated = false;
      for (let fetched = 0; fetched < MAX_TREE_PAGES; fetched += 1) {
        const result = await client.getTree(
          apiBase,
          projectPath,
          target.ref,
          page,
          token,
        );
        for (const entry of result.entries) {
          entries.push({
            path: entry.path,
            type: entry.type === "blob" ? "file" : "dir",
          });
        }
        if (result.nextPage === null) return { entries, truncated };
        page = result.nextPage;
        truncated = true;
      }
      return { entries, truncated };
    },

    async readFileHead(connection, target, path) {
      const { token } = await connection.credential.getToken();
      return client.getFileHead(
        apiBaseOf(connection),
        `${target.owner}/${target.name}`,
        target.ref,
        path,
        token,
      );
    },
  };
}

/** How far discovery will page a tree before calling it truncated. */
const MAX_TREE_PAGES = 10;

/** A cursor we did not issue restarts at page 1 rather than throwing. */
function parseCursor(cursor: string | null | undefined): number {
  const page = Number.parseInt(cursor ?? "1", 10);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function toDiscoveredRepo(project: GitLabProject): DiscoveredRepo {
  const fullName = project.path_with_namespace;
  const namespace =
    project.namespace?.full_path ??
    fullName.slice(0, Math.max(0, fullName.lastIndexOf("/")));
  return {
    externalId: String(project.id),
    fullName,
    owner: namespace,
    name: project.path,
    cloneUrl: project.http_url_to_repo,
    // A project with no commits reports no default branch; the fallback keeps
    // it from becoming a clone of `refs/heads/null`.
    defaultBranch: project.default_branch ?? "main",
    // `internal` is not public: it is visible to instance members only, and a
    // clone still needs a credential.
    private: project.visibility !== "public",
    archived: project.archived,
    updatedAt: project.last_activity_at ? new Date(project.last_activity_at) : null,
  };
}

/** Map a GitLab failure onto the vocabulary the onboarding UI speaks. */
function asDiscoveryError(err: unknown): DiscoveryError {
  if (err instanceof GitLabApiError) {
    if (err.status === 401) {
      return new DiscoveryError(
        "installation_revoked",
        "GitLab refused this connection — reconnect it to continue",
      );
    }
    if (err.status === 403) {
      return new DiscoveryError(
        "insufficient_permissions",
        "this connection is not allowed to list projects — check the scopes it was granted",
      );
    }
  }
  return toDiscoveryError(err);
}

export function createGitLabProvider(
  client: GitLabClient,
  config: IntegrationsConfig,
  oauth2Http: OAuth2Http,
): IntegrationProvider {
  // Only where an OAuth application was registered (GP-195); otherwise GitLab
  // honestly offers PAT alone.
  const flows: ConnectFlow[] = config.gitlabOAuth
    ? [gitlabConnectFlow(config.gitlabOAuth, oauth2Http)]
    : [];

  return defineProvider({
    id: "gitlab",
    label: "GitLab",
    credentialModes: ["oauth2", "pat"],
    hosts: ["gitlab.com"],
    repo,
    // Discovery rides on a connection, so it exists where one can be made
    // (GP-232) — the same posture as the GitHub App. Without a registered
    // OAuth application there is no connection whose scope could be listed.
    discoverer: config.gitlabOAuth ? gitlabDiscoverer(client) : null,
    // Reading a tree needs no app: a PAT does it too, so the capability is
    // always there and the credential decides what can be seen.
    trees: createGitLabTreeReader(client),
    commenter: createGitLabCommenter(client),
    refEvents: gitlabRefEvents,
    connectFlows: flows,
  });
}
