/**
 * Types mirroring the backend base models, field-for-field with the JSON the
 * API actually returns (GP-3, GP-6). Timestamps are ISO strings over the wire.
 */

export type Provider = "github" | "gitlab";

export type ConnectionStatus = "unverified" | "ok" | "failed";

/** Structured reason a connection check failed (GP-11). */
export type VerifyErrorKind = "auth_failed" | "not_found" | "network";

export interface Project {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Repository {
  id: string;
  projectId: string;
  provider: Provider;
  url: string;
  defaultBranch: string;
  /** "***" when a PAT is stored, else null. Never the token value. */
  accessToken: "***" | null;
  connectionStatus: ConnectionStatus;
  verifiedAt: string | null;
  createdAt: string;
}

/** Create-repository response — includes the webhook token, shown once. */
export interface CreatedRepository extends Repository {
  webhookToken: string;
}

export interface UpdateRepositoryInput {
  /** New PAT (write-only). Replaces the stored one and re-verifies. */
  accessToken?: string;
  defaultBranch?: string;
}

/** Result of POST /repositories/:id/verify. */
export type VerifyResult =
  | { ok: true; default_branch_found: boolean }
  | { ok: false; error: VerifyErrorKind };

/** The current user, as returned by GET /me (note: snake_case display_name). */
export interface User {
  id: string;
  email: string | null;
  display_name: string | null;
}

// --- Graph / snapshots / pull requests (GP-12..GP-15) ----------------------

export type ChangeKind = "create" | "update" | "delete" | "noop";
export type EdgeKind = "depends_on" | "contains";
export type SnapshotSource = "plan" | "hcl";
export type PullRequestState = "open" | "closed";

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  provider: string | null;
  module_path: string[];
  change: ChangeKind | null;
  /** v2: unchanged node that (transitively) depends on a changed one (GP-22). */
  impacted?: boolean;
  /** v2: hop distance to the nearest changed node (1 = direct dependent). */
  impact_distance?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** depends_on only: true when inferred from an expression reference (GP-20). */
  inferred?: boolean;
}

export interface Graph {
  version: 1 | 2;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphStats {
  nodes: number;
  edges: number;
  /** Expression-inferred depends_on edges (GP-20). */
  inferredEdges?: number;
  /** Unchanged nodes impacted by the change set (GP-22). */
  impactedCount?: number;
  changes: {
    create: number;
    update: number;
    delete: number;
    noop: number;
    unchanged: number;
  };
  /** Present on docs (hcl) snapshots — skipped files etc. */
  warnings?: string[];
  /** Docs snapshots: how it was produced (GP-23/GP-26). */
  trigger?: "manual" | "auto";
}

/** Snapshot list item — metadata + stats, never the graph body. */
export interface SnapshotSummary {
  id: string;
  repositoryId: string;
  source: SnapshotSource;
  ref: string;
  commitSha: string;
  prNumber: number | null;
  stats: GraphStats;
  createdAt: string;
}

/** Full snapshot including the graph. */
export interface Snapshot extends SnapshotSummary {
  graph: Graph;
}

/** The latest snapshot summary attached to a pull request (no graph). */
export interface PullSnapshotRef {
  id: string;
  stats: GraphStats;
  createdAt: string;
}

export interface PullSummary {
  id: string;
  repositoryId: string;
  number: number;
  title: string | null;
  state: PullRequestState;
  sourceRef: string;
  latestCommitSha: string;
  createdAt: string;
  updatedAt: string;
  latestSnapshot: PullSnapshotRef | null;
}

export interface PullDetail extends PullSummary {
  /** Set when the latest ingestion for this PR failed to parse (no snapshot). */
  parseError: string | null;
}

export interface CreateProjectInput {
  name: string;
  slug: string;
}

export interface CreateRepositoryInput {
  provider: Provider;
  url: string;
  defaultBranch?: string;
  /** Optional token for cloning private repos (write-only server-side). */
  accessToken?: string;
}
