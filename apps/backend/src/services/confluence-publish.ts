/**
 * GP-180: publish a repository's docs snapshot as a Confluence page.
 *
 * The page mirrors the docs of main: title = repo name, body = the
 * deterministic docs summary converted to storage format, the diagram as a PNG
 * attachment, a link back to Groundplan. Create on first publish; idempotent
 * update (version n+1) afterwards; a page deleted on the Confluence side is
 * recreated transparently and the stored id moves with it.
 *
 * Failures never throw out of here: they are mapped to the closed kind set
 * (auth_failed / space_not_found / network), stored on the connection
 * (`last_publish_error`, cleared on success) and returned — the same
 * record-and-carry-on shape as the PR comment (GP-38).
 */
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";

import {
  annotations,
  confluenceConnections,
  graphSnapshots,
  projects,
  repositories,
  type ConfluenceConnectionRow,
  type GraphSnapshotRow,
  type RepositoryRow,
} from "../db/schema.js";
import { buildDocsExplainInput } from "./ai-input.js";
import type {
  ConfluenceErrorKind,
  ConfluencePage,
  ConfluencePageErrorKind,
  ConfluenceTarget,
} from "./confluence.js";
import { DIAGRAM_FILENAME, docsPageStorage } from "./confluence-content.js";
import { docsSourceFor } from "./graph-snapshots.js";
import { cachedSnapshotExport, repoLabel } from "./snapshot-export.js";

export type ConfluencePublishResult =
  | { ok: true; pageUrl: string | null; publishedAt: Date }
  | { ok: false; error: ConfluenceErrorKind };

/**
 * A `page_not_found` that escapes the recreate path is an instance answering
 * nonsense — for the caller that is indistinguishable from not reaching it.
 */
function normalizeKind(kind: ConfluencePageErrorKind): ConfluenceErrorKind {
  return kind === "page_not_found" ? "network" : kind;
}

/** The repository's newest docs snapshot — what a publish publishes. */
export async function latestDocsSnapshot(
  app: FastifyInstance,
  repo: RepositoryRow,
): Promise<GraphSnapshotRow | undefined> {
  const [row] = await app.db
    .select()
    .from(graphSnapshots)
    .where(
      and(
        eq(graphSnapshots.repositoryId, repo.id),
        eq(graphSnapshots.source, docsSourceFor(repo.iacType)),
      ),
    )
    .orderBy(desc(graphSnapshots.createdAt))
    .limit(1);
  return row;
}

/**
 * The page body: the deterministic docs brief (GP-65's grounding input — the
 * inventory, structure, network shape, standing risks and the human-authored
 * context/annotations) rendered to storage format. Deterministic in, page out.
 */
async function buildPageStorage(
  app: FastifyInstance,
  repo: RepositoryRow,
  snapshot: GraphSnapshotRow,
): Promise<string> {
  const [project] = await app.db
    .select()
    .from(projects)
    .where(eq(projects.id, repo.projectId));
  // Kubernetes repositories carry no annotation layer (GP-100).
  const notes =
    repo.iacType === "kubernetes"
      ? []
      : await app.db
          .select()
          .from(annotations)
          .where(
            and(
              eq(annotations.repositoryId, repo.id),
              eq(annotations.status, "resolved"),
            ),
          )
          .orderBy(asc(annotations.createdAt));

  const summaryMd = buildDocsExplainInput({
    repo,
    graph: snapshot.graph,
    context: {
      projectName: project?.name ?? "",
      projectContextMd: project?.contextMd ?? null,
      repoContextMd: repo.contextMd,
    },
    annotations: notes,
  });

  const appUrl = app.publicBaseUrl
    ? `${app.publicBaseUrl}/projects/${repo.projectId}/repos/${repo.id}/docs`
    : null;

  return docsPageStorage({
    repoLabel: repoLabel(repo.url),
    ref: snapshot.ref,
    commitSha: snapshot.commitSha,
    generatedAt: snapshot.createdAt,
    summaryMd,
    appUrl,
  });
}

/**
 * Update the stored page if it still exists; (re)create it otherwise. Only a
 * missing page falls through to create — every other failure is final here.
 */
async function ensurePage(
  app: FastifyInstance,
  target: ConfluenceTarget,
  connection: ConfluenceConnectionRow,
  title: string,
  storage: string,
): Promise<{ ok: true; page: ConfluencePage } | { ok: false; error: ConfluenceErrorKind }> {
  if (connection.pageId) {
    const existing = await app.confluence.getPage(target, connection.pageId);
    if (existing.ok) {
      const updated = await app.confluence.updatePage(target, {
        pageId: connection.pageId,
        title,
        storage,
        version: existing.page.version + 1,
      });
      if (updated.ok) return updated;
      if (updated.error !== "page_not_found") {
        return { ok: false, error: normalizeKind(updated.error) };
      }
      // Deleted between the GET and the PUT — recreate below.
    } else if (existing.error !== "page_not_found") {
      return { ok: false, error: normalizeKind(existing.error) };
    }
  }

  const created = await app.confluence.createPage(target, {
    spaceKey: connection.spaceKey,
    title,
    storage,
  });
  if (!created.ok) return { ok: false, error: normalizeKind(created.error) };
  return created;
}

async function recordFailure(
  app: FastifyInstance,
  connectionId: string,
  error: ConfluenceErrorKind,
): Promise<ConfluencePublishResult> {
  await app.db
    .update(confluenceConnections)
    .set({ lastPublishError: error })
    .where(eq(confluenceConnections.id, connectionId));
  return { ok: false, error };
}

/** Publish one docs snapshot to the repository's configured Confluence page. */
export async function publishDocsSnapshot(
  app: FastifyInstance,
  repo: RepositoryRow,
  connection: ConfluenceConnectionRow,
  snapshot: GraphSnapshotRow,
): Promise<ConfluencePublishResult> {
  let credential: string;
  try {
    credential = app.encryptor.decrypt(connection.credential);
  } catch {
    app.log.warn(
      { connectionId: connection.id },
      "could not decrypt stored Confluence credential",
    );
    return recordFailure(app, connection.id, "auth_failed");
  }

  const target: ConfluenceTarget = {
    baseUrl: connection.baseUrl,
    authType: connection.authType,
    email: connection.email,
    credential,
  };

  const storage = await buildPageStorage(app, repo, snapshot);
  // The same deterministic render + disk cache the export routes use (GP-37).
  const png = await cachedSnapshotExport(app.exportCacheDir, {
    snapshot,
    repoUrl: repo.url,
    format: "png",
    scope: "full",
  });

  const ensured = await ensurePage(
    app,
    target,
    connection,
    repoLabel(repo.url),
    storage,
  );
  if (!ensured.ok) return recordFailure(app, connection.id, ensured.error);

  const attached = await app.confluence.uploadAttachment(target, {
    pageId: ensured.page.id,
    filename: DIAGRAM_FILENAME,
    contentType: "image/png",
    data: png.body,
  });
  if (!attached.ok) {
    return recordFailure(app, connection.id, normalizeKind(attached.error));
  }

  const publishedAt = new Date();
  await app.db
    .update(confluenceConnections)
    .set({
      pageId: ensured.page.id,
      pageUrl: ensured.page.url,
      lastPublishedAt: publishedAt,
      lastPublishError: null,
    })
    .where(eq(confluenceConnections.id, connection.id));

  return { ok: true, pageUrl: ensured.page.url, publishedAt };
}

/**
 * The on-merge hook (GP-23 → GP-180): publish a fresh docs snapshot when — and
 * only when — its repository has a Confluence connection. Never throws: a
 * failed publish is a recorded fact on the connection, not a failed docs pass.
 */
export async function autoPublishDocsSnapshot(
  app: FastifyInstance,
  snapshot: GraphSnapshotRow,
): Promise<void> {
  if (snapshot.repositoryId === null) return;
  try {
    const [repo] = await app.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, snapshot.repositoryId));
    if (!repo) return;
    const [connection] = await app.db
      .select()
      .from(confluenceConnections)
      .where(eq(confluenceConnections.repositoryId, repo.id));
    if (!connection) return; // no connection → zero Confluence calls
    const result = await publishDocsSnapshot(app, repo, connection, snapshot);
    if (!result.ok) {
      app.log.warn(
        { repositoryId: repo.id, error: result.error },
        "auto-publish to Confluence failed",
      );
    }
  } catch (err) {
    app.log.error(
      { err, snapshotId: snapshot.id },
      "auto-publish to Confluence failed",
    );
  }
}
