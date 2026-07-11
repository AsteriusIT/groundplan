import type { FastifyInstance } from "fastify";

import type { GraphSnapshotRow, RepositoryRow } from "../db/schema.js";
import { parseHclRepo } from "../graph/hcl-parser.js";
import { insertGraphSnapshot } from "./graph-snapshots.js";
import { readRepoTextFiles } from "./repo-files.js";

/** Thrown when a docs generation is already running for a repository. */
export class DocsGenerationInProgressError extends Error {
  constructor() {
    super("documentation generation already in progress for this repository");
    this.name = "DocsGenerationInProgressError";
  }
}

// Per-repo in-memory lock: one docs generation at a time. Acquired synchronously
// (before the first await) so two overlapping calls can't both pass the guard.
const generating = new Set<string>();

/**
 * Producer B (GP-15): clone the repo's default branch, statically parse its
 * Terraform, and store a `source=hcl` GraphSnapshot. Synchronous for now (no
 * queue); the clone is always cleaned up by `readRepoTextFiles`.
 */
export async function generateDocsSnapshot(
  app: FastifyInstance,
  repo: RepositoryRow,
): Promise<GraphSnapshotRow> {
  if (generating.has(repo.id)) throw new DocsGenerationInProgressError();
  generating.add(repo.id);
  try {
    let accessToken: string | null = null;
    if (repo.accessToken) {
      try {
        accessToken = app.encryptor.decrypt(repo.accessToken);
      } catch (err) {
        app.log.warn({ err, repositoryId: repo.id }, "could not decrypt stored PAT");
      }
    }

    const { files, headSha } = await readRepoTextFiles(
      {
        url: repo.url,
        provider: repo.provider,
        ref: repo.defaultBranch,
        accessToken,
      },
      (path) => path.endsWith(".tf"),
    );

    const { graph, warnings } = parseHclRepo(files);

    return await insertGraphSnapshot(app.db, {
      repositoryId: repo.id,
      source: "hcl",
      ref: repo.defaultBranch,
      commitSha: headSha,
      prNumber: null,
      graph,
      extraStats: { warnings },
    });
  } finally {
    generating.delete(repo.id);
  }
}
