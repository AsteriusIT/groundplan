/**
 * The GitHub adapter (GP-192). Everything GitHub-specific lives here: the hosts
 * it owns, the clone username, and the idempotent PR comment — the behaviour
 * GP-38 shipped, moved behind the port unchanged.
 */
import {
  parseGitHubRepo,
  type GitHubClient,
} from "../../services/github.js";
import type { IntegrationsConfig } from "../config.js";
import { defineProvider } from "../provider.js";
import type {
  ConnectFlow,
  IntegrationProvider,
  PullRequestCommenter,
  RepoReader,
} from "../types.js";
import { githubRefEvents } from "../webhooks.js";
import { githubAppConnectFlow, type GitHubAppClient } from "./github-app.js";

/**
 * `x-access-token` for every mode: it is what GitHub documents for a PAT *and*
 * for an App installation token, which is precisely why the App can reuse the
 * whole clone path untouched.
 */
const repo: RepoReader = {
  cloneUsername: () => "x-access-token",
};

/** PR comments: find the one comment carrying our marker, else create it. */
export function createGitHubCommenter(client: GitHubClient): PullRequestCommenter {
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
        await client.updateIssueComment(
          target.owner,
          target.repo,
          existing.id,
          body,
          token,
        );
      } else {
        await client.createIssueComment(
          target.owner,
          target.repo,
          prNumber,
          body,
          token,
        );
      }
    },
  };
}

export function createGitHubProvider(
  client: GitHubClient,
  config: IntegrationsConfig,
  appClient: GitHubAppClient,
): IntegrationProvider {
  // The App install flow exists only where an App was registered (GP-193);
  // otherwise the provider honestly offers PAT alone.
  const flows: ConnectFlow[] = config.githubApp
    ? [githubAppConnectFlow(config.githubApp, appClient)]
    : [];

  return defineProvider({
    id: "github",
    label: "GitHub",
    // `installation_app` first (GP-193): when an installation covers the repo it
    // is the better credential, and the attach flow offers modes in this order.
    credentialModes: ["installation_app", "pat"],
    hosts: ["github.com"],
    repo,
    commenter: createGitHubCommenter(client),
    // Push/PR deliveries (GP-194). The App provides them natively; a PAT-only
    // repository can still have a webhook configured by hand.
    refEvents: githubRefEvents,
    connectFlows: flows,
  });
}
