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
  /** GP-38: whether PR plan snapshots post a GitHub comment. */
  prCommentsEnabled: boolean;
  /** GP-38: last PR-comment error to surface in settings, or null. */
  lastCommentError: string | null;
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
  /** GP-38: toggle GitHub PR comments for this repository. */
  prCommentsEnabled?: boolean;
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

/** v3: one masked before/after attribute change on a node (GP-32). */
export interface AttributeDiffRow {
  key: string;
  /** null for a create (attribute added); "(sensitive)" when masked. */
  before: string | null;
  /** null for a delete; "(sensitive)" / "(known after apply)" as applicable. */
  after: string | null;
}

/** v4: one NSG security rule; raw values, only `ports` normalized (GP-43). */
export interface NsgRule {
  name: string;
  priority: number;
  direction: string;
  access: string;
  protocol: string;
  ports: string;
  source: string;
  destination: string;
}

/**
 * v4: role-assignment payload on an azurerm_role_assignment node (GP-47).
 * `principal`/`scope` are resolved node addresses when they reference a
 * resource in the snapshot, otherwise the raw Azure id / object id.
 */
export interface RoleAssignment {
  role: string;
  principal: string;
  scope: string;
  principal_type?: string;
}

/** v4: managed-identity payload — UAI nodes & resources with identity{} (GP-47). */
export interface Identity {
  type: string;
  identity_ids?: string[];
}

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
  /** v3: masked per-attribute before/after diff for a changed node (GP-32). */
  attribute_diff?: AttributeDiffRow[];
  /** v3: true when the changed-attribute list exceeded 20 and was capped. */
  attribute_diff_truncated?: boolean;
  /** v4: id of the containing node (vnet⊃subnet⊃resource); network only (GP-42). */
  parent_id?: string;
  /** v4: security rules on an azurerm_network_security_group node (GP-43). */
  rules?: NsgRule[];
  /** v4: true iff this NSG has an inbound Allow rule from an internet source. */
  internet_exposed?: boolean;
  /** v4: node ids of the subnets/NICs this NSG is associated with (GP-43/45). */
  associated_ids?: string[];
  /** v4: role-assignment payload on an azurerm_role_assignment node (GP-47). */
  role_assignment?: RoleAssignment;
  /** v4: true iff this role assignment is a broad-scope high-privilege grant (GP-47). */
  privileged?: boolean;
  /** v4: managed-identity payload — UAI nodes & resources with identity{} (GP-47). */
  identity?: Identity;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** depends_on only: true when inferred from an expression reference (GP-20). */
  inferred?: boolean;
}

export interface Graph {
  version: 1 | 2 | 3 | 4;
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
  /** Deterministic rule-based Markdown change summary (GP-36). */
  summaryMd: string;
}

// --- Docs snapshot diff (GP-40) --------------------------------------------

export interface DiffNode {
  id: string;
  name: string;
  type: string;
  module_path: string[];
}

export interface MovedNode {
  id: string;
  name: string;
  type: string;
  from_module_path: string[];
  to_module_path: string[];
}

/** Result of comparing two docs snapshots (base → target). */
export interface SnapshotDiff {
  base: { id: string; commitSha: string; createdAt: string };
  target: { id: string; commitSha: string; createdAt: string };
  added: DiffNode[];
  removed: DiffNode[];
  moved: MovedNode[];
  unchangedCount: number;
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

// --- Public share links (GP-39) --------------------------------------------

export type ShareKind = "docs_latest" | "snapshot";

/** A share link as returned to its authenticated owner (includes the token). */
export interface ShareLink {
  id: string;
  token: string;
  kind: ShareKind;
  /** Set for a pinned (`snapshot`) link; null for `docs_latest`. */
  snapshotId: string | null;
  createdAt: string;
}

export interface CreateShareLinkInput {
  kind: ShareKind;
  /** Required when kind = "snapshot". */
  snapshotId?: string;
}

/** The credential-free snapshot payload served on public routes. */
export interface PublicSnapshotView {
  kind: ShareKind;
  repository: { name: string; provider: Provider };
  snapshot: {
    id: string;
    source: SnapshotSource;
    ref: string;
    commitSha: string;
    createdAt: string;
    stats: GraphStats;
    summaryMd: string;
    graph: Graph;
  };
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
