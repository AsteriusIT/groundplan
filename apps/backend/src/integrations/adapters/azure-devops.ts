/**
 * The Azure DevOps adapter (GP-192): hosts, clone username and the idempotent
 * PR comment thread (GP-54's behaviour, moved behind the port).
 */
import {
  parseAzureDevOpsRepo,
  type AzureDevOpsClient,
} from "../../services/azure-devops.js";
import { defineProvider } from "../provider.js";
import type {
  IntegrationProvider,
  PullRequestCommenter,
  RepoReader,
} from "../types.js";

/**
 * Azure DevOps ignores the username on an https clone and reads the password —
 * PAT or Entra access token alike — so one constant covers both modes.
 */
const repo: RepoReader = {
  cloneUsername: () => "pat",
};

export function createAzureDevOpsCommenter(
  client: AzureDevOpsClient,
): PullRequestCommenter {
  return {
    async upsertComment({ repoUrl, prNumber, marker, body, token }) {
      const target = parseAzureDevOpsRepo(repoUrl);
      if (!target) throw new Error(`not an Azure DevOps repository URL: ${repoUrl}`);
      const threads = await client.listThreads(
        target.apiBase,
        target.project,
        target.repo,
        prNumber,
        token,
      );
      // Our comment is the first comment of a thread carrying the marker.
      let existing: { threadId: number; commentId: number } | null = null;
      for (const thread of threads) {
        const first = thread.comments[0];
        if (first?.content.includes(marker)) {
          existing = { threadId: thread.id, commentId: first.id };
          break;
        }
      }
      if (existing) {
        await client.updateComment(
          target.apiBase,
          target.project,
          target.repo,
          prNumber,
          existing.threadId,
          existing.commentId,
          body,
          token,
        );
      } else {
        await client.createThread(
          target.apiBase,
          target.project,
          target.repo,
          prNumber,
          body,
          token,
        );
      }
    },
  };
}

export function createAzureDevOpsProvider(
  client: AzureDevOpsClient,
): IntegrationProvider {
  return defineProvider({
    id: "azure_devops",
    label: "Azure DevOps",
    credentialModes: ["oauth2", "pat"],
    hosts: ["dev.azure.com", ".visualstudio.com"],
    repo,
    commenter: createAzureDevOpsCommenter(client),
  });
}
