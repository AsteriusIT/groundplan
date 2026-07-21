/**
 * Share-link plumbing (GP-39): create tokenized read-only links to a docs
 * snapshot and resolve them (respecting revocation) to the snapshot they point
 * at. A `docs_latest` link always resolves to the newest docs snapshot; a
 * `snapshot` link is pinned to one. The public HTTP layer maps the resolved
 * snapshot into a minimal, credential-free shape — the raw repository row (PAT,
 * webhook token) never leaves this module.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, desc, eq, isNull } from "drizzle-orm";

import {
  annotations,
  graphSnapshots,
  repositories,
  shareTokens,
  toPublicAnnotation,
  type AnnotationRow,
  type GraphSnapshotRow,
  type ShareTokenRow,
} from "../db/schema.js";
import { generateToken } from "../lib/tokens.js";
import { repoLabel } from "./snapshot-export.js";

export type ShareKind = ShareTokenRow["kind"];

/** The API shape for a share link — safe to show the authenticated owner. */
export interface PublicShareLink {
  id: string;
  token: string;
  kind: ShareKind;
  snapshotId: string | null;
  createdAt: Date;
}

export function toPublicShareLink(row: ShareTokenRow): PublicShareLink {
  return {
    id: row.id,
    token: row.token,
    kind: row.kind,
    snapshotId: row.snapshotId,
    createdAt: row.createdAt,
  };
}

/** Create a share link for a repository (optionally pinned to a snapshot). */
export async function createShareLink(
  db: NodePgDatabase,
  input: {
    repositoryId: string;
    kind: ShareKind;
    snapshotId?: string | null;
    createdBy?: string | null;
  },
): Promise<ShareTokenRow> {
  const [row] = await db
    .insert(shareTokens)
    .values({
      token: generateToken(),
      repositoryId: input.repositoryId,
      kind: input.kind,
      snapshotId: input.kind === "snapshot" ? (input.snapshotId ?? null) : null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return row as ShareTokenRow;
}

/**
 * Reuse or create a pinned (`snapshot`) share link for a snapshot. Used by the
 * PR comment (GP-38) so a public image URL exists without minting a fresh token
 * on every push. Returns the token string.
 */
export async function ensureSnapshotShareLink(
  db: NodePgDatabase,
  repositoryId: string,
  snapshotId: string,
): Promise<string> {
  const [existing] = await db
    .select({ token: shareTokens.token })
    .from(shareTokens)
    .where(
      and(
        eq(shareTokens.snapshotId, snapshotId),
        eq(shareTokens.kind, "snapshot"),
        isNull(shareTokens.revokedAt),
      ),
    )
    .limit(1);
  if (existing) return existing.token;

  const row = await createShareLink(db, {
    repositoryId,
    kind: "snapshot",
    snapshotId,
  });
  return row.token;
}

/**
 * The token of an existing, non-revoked `docs_latest` share link for a
 * repository, or null when none exists (GP-182). Unlike `ensureSnapshotShareLink`
 * this never *creates* a link: publishing to Confluence must not silently mint a
 * public link — it reuses one the team already chose to make, else the backlink
 * falls back to the (login-guarded) in-app docs URL.
 */
export async function findDocsLatestShareToken(
  db: NodePgDatabase,
  repositoryId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ token: shareTokens.token })
    .from(shareTokens)
    .where(
      and(
        eq(shareTokens.repositoryId, repositoryId),
        eq(shareTokens.kind, "docs_latest"),
        isNull(shareTokens.revokedAt),
      ),
    )
    .orderBy(desc(shareTokens.createdAt))
    .limit(1);
  return row?.token ?? null;
}

/** Active (non-revoked) links for a repository, newest first. */
export async function listShareLinks(
  db: NodePgDatabase,
  repositoryId: string,
): Promise<ShareTokenRow[]> {
  return db
    .select()
    .from(shareTokens)
    .where(
      and(
        eq(shareTokens.repositoryId, repositoryId),
        isNull(shareTokens.revokedAt),
      ),
    )
    .orderBy(desc(shareTokens.createdAt));
}

/** Mark a share link revoked. Returns the updated row, or undefined if absent. */
export async function revokeShareLink(
  db: NodePgDatabase,
  id: string,
): Promise<ShareTokenRow | undefined> {
  const [row] = await db
    .update(shareTokens)
    .set({ revokedAt: new Date() })
    .where(eq(shareTokens.id, id))
    .returning();
  return row;
}

/** The snapshot + repository a live share token resolves to. */
export interface ResolvedShare {
  token: ShareTokenRow;
  snapshot: GraphSnapshotRow;
  repoUrl: string;
  repoProvider: string;
  /** GP-60: the repository's long-form context, shown read-only in the view. */
  repoContextMd: string | null;
  /** The repository's annotation layer (GP-58); filtered to renderable ones on
   * output, so public viewers see notes/links/groups but never orphans. */
  annotations: AnnotationRow[];
}

/**
 * Resolve a share token to its snapshot, or null when the token is unknown,
 * revoked, or its target snapshot no longer exists. `docs_latest` picks the
 * newest docs (hcl) snapshot each time it is resolved.
 */
export async function resolveShareToken(
  db: NodePgDatabase,
  token: string,
): Promise<ResolvedShare | null> {
  const [share] = await db
    .select()
    .from(shareTokens)
    .where(and(eq(shareTokens.token, token), isNull(shareTokens.revokedAt)));
  if (!share) return null;

  const [repo] = await db
    .select({
      url: repositories.url,
      provider: repositories.provider,
      contextMd: repositories.contextMd,
    })
    .from(repositories)
    .where(eq(repositories.id, share.repositoryId));
  if (!repo) return null;

  let snapshot: GraphSnapshotRow | undefined;
  if (share.kind === "snapshot" && share.snapshotId) {
    [snapshot] = await db
      .select()
      .from(graphSnapshots)
      .where(eq(graphSnapshots.id, share.snapshotId));
  } else {
    [snapshot] = await db
      .select()
      .from(graphSnapshots)
      .where(
        and(
          eq(graphSnapshots.repositoryId, share.repositoryId),
          eq(graphSnapshots.source, "hcl"),
        ),
      )
      .orderBy(desc(graphSnapshots.createdAt))
      .limit(1);
  }
  if (!snapshot) return null;

  const repoAnnotations = await db
    .select()
    .from(annotations)
    .where(eq(annotations.repositoryId, share.repositoryId));

  return {
    token: share,
    snapshot,
    repoUrl: repo.url,
    repoProvider: repo.provider,
    repoContextMd: repo.contextMd,
    annotations: repoAnnotations,
  };
}

/**
 * A share link is unauthenticated, so the node's HCL source (v8, GP-120) does not
 * travel on it: a diagram of the estate is what the reader chose to share, the
 * repository's Terraform is not. Stripped here rather than at the renderer — the
 * payload is the boundary, and the epic's own note defers this to GP-39, which is
 * this file. Everything else about the node is unchanged.
 */
function withoutSource(graph: ResolvedShare["snapshot"]["graph"]) {
  if (!graph.nodes.some((n) => n.source !== undefined)) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map(({ source: _source, ...node }) => node),
  };
}

/** The minimal, credential-free snapshot payload served on public routes. */
export function toPublicSnapshotView(resolved: ResolvedShare) {
  const { snapshot } = resolved;
  // Only annotations whose every anchor exists in this snapshot are shown —
  // viewers see notes/links/groups that render, never orphans (GP-58/GP-59).
  const nodeIds = new Set(snapshot.graph.nodes.map((n) => n.id));
  const publicAnnotations = resolved.annotations
    .filter((a) => a.anchors.every((anchor) => nodeIds.has(anchor)))
    .map(toPublicAnnotation);
  return {
    kind: resolved.token.kind,
    repository: {
      name: repoLabel(resolved.repoUrl),
      provider: resolved.repoProvider,
      context: resolved.repoContextMd,
    },
    annotations: publicAnnotations,
    snapshot: {
      id: snapshot.id,
      source: snapshot.source,
      ref: snapshot.ref,
      commitSha: snapshot.commitSha,
      createdAt: snapshot.createdAt,
      stats: snapshot.stats,
      summaryMd: snapshot.summaryMd,
      graph: withoutSource(snapshot.graph),
    },
  };
}
