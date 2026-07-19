import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";

import {
  graphSnapshots,
  repositories,
  type GraphSnapshotRow,
  type RepositoryRow,
} from "../db/schema.js";
import { parseHclRepo } from "@groundplan/graph-parser";

import type { Graph, UnresolvedReference } from "../graph/graph.js";
import { mapK8sObjects } from "../graph/k8s-mapper.js";
import { isManifestPath, parseManifests } from "../graph/manifest-parser.js";
import { reconcileRepositoryAnnotations } from "./annotation-reconcile.js";
import { docsSourceFor, insertGraphSnapshot } from "./graph-snapshots.js";
import { readRepoTextFiles, type RepoTextFile } from "./repo-files.js";

/** Thrown when a docs generation is already running for a repository. */
export class DocsGenerationInProgressError extends Error {
  constructor() {
    super("documentation generation already in progress for this repository");
    this.name = "DocsGenerationInProgressError";
  }
}

/**
 * Thrown when a kubernetes repository's manifests root yields no objects at all.
 *
 * We could store the empty graph and call it documentation. We don't: an empty
 * diagram is indistinguishable from a broken one, and for the repository this
 * most often happens to — a Helm chart, whose templates are Go source and not
 * YAML — there is a real answer, which is to render in CI and post the result
 * (GP-103). Saying so beats drawing nothing and letting the user wonder.
 */
export class NoManifestsError extends Error {
  readonly warnings: string[];
  constructor(warnings: string[]) {
    super(
      "no Kubernetes objects found in this repository's manifests path — if it is a Helm chart or a kustomize overlay, its diagram comes from your CI rendering it (see the Kubernetes CI setup)",
    );
    this.name = "NoManifestsError";
    this.warnings = warnings;
  }
}

/** How a docs snapshot was produced (GP-23 / GP-26 timeline badge). */
export type DocsTrigger = "manual" | "auto";

export type GenerateDocsOptions = {
  /** Check out this exact commit instead of the branch tip (auto-docs). */
  commitSha?: string;
  /** Recorded in stats.trigger for the docs history timeline. */
  trigger?: DocsTrigger;
};

// Per-repo in-memory lock: one docs generation at a time. Acquired synchronously
// (before the first await) so two overlapping calls can't both pass the guard.
const generating = new Set<string>();

/** What a producer hands back: the graph, and everything worth saying about it. */
type Produced = { graph: Graph; extraStats: Record<string, unknown> };

/**
 * Producer B (GP-15): statically parse the repository's Terraform.
 *
 * The repository's Terraform root is the parse entrypoint. Every .tf file in the
 * clone is still handed over, so a module sourced from above that root
 * (`../modules/shared`) resolves — only the starting directory moves.
 */
function produceHcl(files: RepoTextFile[], repo: RepositoryRow): Produced {
  const { graph, warnings, unresolvedReferences } = parseHclRepo(files, {
    rootDir: repo.terraformPath,
  });
  return {
    graph,
    extraStats: {
      warnings,
      ...(unresolvedReferences.length > 0 ? { unresolvedReferences } : {}),
    },
  };
}

/**
 * Producer B for Kubernetes (GP-102): parse the repository's YAML manifests.
 *
 * Unlike the HCL parse, the walk is confined to the manifests root: manifests have
 * no `../modules/shared` to resolve, so a file outside the root is not context —
 * it is somebody else's stack.
 */
function produceManifests(files: RepoTextFile[], repo: RepositoryRow): Produced {
  const result = parseManifests(files, { rootDir: repo.terraformPath });
  if (result.objects.length === 0) throw new NoManifestsError(result.warnings);
  const unresolved: UnresolvedReference[] = [];
  const graph = mapK8sObjects(result.objects, { unresolved });
  return {
    graph,
    extraStats: {
      warnings: result.warnings,
      skippedDocuments: result.skippedDocuments,
      skippedFiles: result.skippedFiles,
      ...(unresolved.length > 0 ? { unresolvedReferences: unresolved } : {}),
    },
  };
}

/**
 * Living documentation of the default branch: clone it, parse what it holds, and
 * store a docs GraphSnapshot. Synchronous for now (no queue); the clone is always
 * cleaned up by `readRepoTextFiles`.
 *
 * Which producer runs is the repository's own answer (GP-101) — the flow around
 * it (lock, clone, store, reconcile) is the same either way, which is why
 * Kubernetes needed no second copy of it.
 */
export async function generateDocsSnapshot(
  app: FastifyInstance,
  repo: RepositoryRow,
  opts: GenerateDocsOptions = {},
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

    const kubernetes = repo.iacType === "kubernetes";
    const { files, headSha } = await readRepoTextFiles(
      { url: repo.url, provider: repo.provider, ref: repo.defaultBranch, accessToken },
      kubernetes ? isManifestPath : (path) => path.endsWith(".tf"),
      opts.commitSha,
    );

    const { graph, extraStats } = kubernetes
      ? produceManifests(files, repo)
      : produceHcl(files, repo);

    const snapshot = await insertGraphSnapshot(app.db, {
      repositoryId: repo.id,
      source: docsSourceFor(repo.iacType),
      ref: repo.defaultBranch,
      commitSha: headSha,
      prNumber: null,
      graph,
      extraStats: { ...extraStats, trigger: opts.trigger ?? "manual" },
    });

    // Reconcile the annotation layer against the new snapshot (ADR #4 / GP-57):
    // a deterministic, synchronous post-step, so every docs generation (manual,
    // regenerate, on-merge) keeps annotation status in sync with the graph.
    // Kubernetes snapshots carry no annotation layer yet (GP-100 excludes it), so
    // there is nothing to reconcile them against — and reconciling anyway would
    // quietly orphan a repository's Terraform annotations against a YAML graph.
    if (!kubernetes) await reconcileRepositoryAnnotations(app.db, repo.id, graph);

    return snapshot;
  } finally {
    generating.delete(repo.id);
  }
}

/** Does a webhook `ref` point at the repository's default branch? */
function isDefaultBranch(ref: string, defaultBranch: string): boolean {
  return ref === defaultBranch || ref === `refs/heads/${defaultBranch}`;
}

/**
 * Regenerate the docs snapshot of `main` for one commit — the shared core of
 * living documentation, reached two ways: a `push` webhook (GP-23) and the ref
 * poller's `MainUpdated` (GP-108). Both want the same behaviour, so it lives once.
 *
 * **Idempotent by sha**: if a docs snapshot for `(repo, commitSha)` already
 * exists it skips, so a webhook and a poll tick for the same commit produce one
 * snapshot, not two. **Non-fatal**: a locked generation, a templated chart, or a
 * parse error is logged and swallowed — a failure never removes or corrupts the
 * previous snapshot, because generation only ever *inserts* a new row.
 */
export async function regenerateDocsForSha(
  app: FastifyInstance,
  repo: RepositoryRow,
  commitSha: string,
): Promise<void> {
  const [existing] = await app.db
    .select({ id: graphSnapshots.id })
    .from(graphSnapshots)
    .where(
      and(
        eq(graphSnapshots.repositoryId, repo.id),
        eq(graphSnapshots.source, docsSourceFor(repo.iacType)),
        eq(graphSnapshots.commitSha, commitSha),
      ),
    )
    .limit(1);
  if (existing) {
    app.log.info(
      { repositoryId: repo.id, commitSha },
      "docs snapshot already exists for this sha, skipping auto-generation",
    );
    return;
  }

  try {
    await generateDocsSnapshot(app, repo, { commitSha, trigger: "auto" });
  } catch (err) {
    if (err instanceof DocsGenerationInProgressError) {
      app.log.info(
        { repositoryId: repo.id },
        "docs generation already running, skipping (next main update will regenerate)",
      );
    } else if (err instanceof NoManifestsError) {
      // A templated chart on merge to main: expected, and not a failure. The
      // pull-request flow renders it in CI (GP-103); there is nothing to do here.
      app.log.info(
        { repositoryId: repo.id, warnings: err.warnings },
        "no Kubernetes objects in the manifests path, skipping docs generation",
      );
    } else {
      app.log.error({ err, repositoryId: repo.id }, "auto docs generation failed");
    }
  }
}

type PushBody = { ref: string; commit_sha: string; event: string };

/**
 * Living docs (GP-23): a push to the default branch regenerates the docs
 * snapshot for the pushed commit. A thin front for `regenerateDocsForSha`,
 * intended to run in the background after the webhook 202.
 *
 * The poller supersedes this (GP-108) — a push webhook is no longer required for
 * docs to stay current — but it coexists: a repository whose CI still posts push
 * events gets the same idempotent result, one snapshot per commit either way.
 */
export async function autoGenerateDocsOnPush(
  app: FastifyInstance,
  repositoryId: string,
  body: PushBody,
): Promise<void> {
  if (body.event !== "push") return;

  const [repo] = await app.db
    .select()
    .from(repositories)
    .where(eq(repositories.id, repositoryId));
  if (!repo || !isDefaultBranch(body.ref, repo.defaultBranch)) return;

  await regenerateDocsForSha(app, repo, body.commit_sha);
}
