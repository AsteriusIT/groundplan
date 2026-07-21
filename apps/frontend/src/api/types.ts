/**
 * Types mirroring the backend base models, field-for-field with the JSON the
 * API actually returns (GP-3, GP-6). Timestamps are ISO strings over the wire.
 */

export type Provider = "github" | "gitlab" | "azure_devops" | "generic";

export type ConnectionStatus = "unverified" | "ok" | "failed";

/** Structured reason a connection check failed (GP-11). */
export type VerifyErrorKind = "auth_failed" | "not_found" | "network";

export interface Project {
  id: string;
  name: string;
  slug: string;
  /** GP-60: long-form markdown context, or null. */
  contextMd: string | null;
  createdAt: string;
}

/** What a repository holds (GP-101). Set when it is attached; immutable after. */
export type IacType = "terraform" | "kubernetes";

export interface Repository {
  id: string;
  projectId: string;
  provider: Provider;
  /** Terraform, or Kubernetes manifests (GP-101). Decides every producer below. */
  iacType: IacType;
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
  /** GP-60: long-form markdown context for this repository, or null. */
  contextMd: string | null;
  /**
   * Subdirectory the IaC lives in; "" is the repository root. It moves the
   * entrypoint of the documentation parse (like `terraform -chdir`); what CI
   * sends comes rendered and ignores it.
   *
   * The name is the column's (GP-101): for a kubernetes repository this is the
   * manifests directory, and the UI calls it "Manifests path".
   */
  terraformPath: string;
  createdAt: string;
}

/** Create-repository response — includes the webhook token, shown once. */
export interface CreatedRepository extends Repository {
  webhookToken: string;
}

/** Whether the app-wide CI token is set, and when it was last set (not the value). */
export interface IngestionSettings {
  appWebhookTokenSet: boolean;
  updatedAt: string | null;
}

/** A freshly generated app-wide CI token — the one time its value is returned. */
export interface AppWebhookToken {
  webhookToken: string;
}

/**
 * Freshness signal for one repository, as the project page shows it. Every repo
 * in the project gets a row; a quiet one is zeroed, not missing.
 */
export interface RepositoryActivity {
  repositoryId: string;
  openPrs: number;
  /** Last plan or docs snapshot stored, or null if none. */
  lastSnapshotAt: string | null;
  /** Last CI webhook received — null means CI has never reached us. */
  lastEventAt: string | null;
}

export interface UpdateRepositoryInput {
  /** New PAT (write-only). Replaces the stored one and re-verifies. */
  accessToken?: string;
  defaultBranch?: string;
  /** GP-38: toggle GitHub PR comments for this repository. */
  prCommentsEnabled?: boolean;
  /** GP-60: long-form markdown context (null clears it). */
  contextMd?: string | null;
  /** Subdirectory the Terraform lives in; "" moves it back to the repo root. */
  terraformPath?: string;
}

/** Result of POST /repositories/:id/verify. */
export type VerifyResult =
  | { ok: true; default_branch_found: boolean }
  | { ok: false; error: VerifyErrorKind };

/**
 * One CI webhook Groundplan received (GP-5), as the events list returns it —
 * everything except the (large) payload. It answers "did my CI actually reach
 * us?" on the setup page (GP-111): the most recent one is the last plan received.
 */
export interface IngestionEvent {
  id: string;
  /** The branch/ref CI reported (e.g. `refs/heads/feature-x` or `main`). */
  ref: string;
  commitSha: string;
  event: "push" | "pull_request";
  /** Set when the plan failed to parse (GP-13); null when it parsed or wasn't one. */
  parseError: string | null;
  receivedAt: string;
}

// --- Kubernetes clusters (GP-95 / GP-97) ------------------------------------

/** Why a cluster check failed. `invalid_config` = the kubeconfig itself is bad. */
export type K8sErrorKind = VerifyErrorKind | "invalid_config";

/**
 * An attached Kubernetes cluster (GP-95). It belongs to **no project** — a
 * project holds repositories, whose PRs we review; a cluster is a running thing
 * we read, and it lives at the top level beside them. The kubeconfig is
 * write-only: it is never returned, so this type says so — the only value the
 * field can ever hold is the mask.
 */
export interface Cluster {
  id: string;
  name: string;
  /** Always "***". The kubeconfig you sent is never sent back. */
  kubeconfig: "***";
  connectionStatus: ConnectionStatus;
  verifiedAt: string | null;
  createdAt: string;
}

export interface CreateClusterInput {
  name: string;
  /** The kubeconfig YAML. Write-only server-side; we use its current context. */
  kubeconfig: string;
}

export interface UpdateClusterInput {
  name?: string;
  /** Replace-only: a new kubeconfig overwrites the stored one and re-verifies. */
  kubeconfig?: string;
}

/** Result of POST /clusters/:id/verify. */
export type ClusterVerifyResult =
  | { ok: true; version: string | null }
  | { ok: false; error: K8sErrorKind };

// --- Confluence export (GP-179..GP-181) --------------------------------------

/** How the Confluence credential authenticates: Cloud API token or DC PAT. */
export type ConfluenceAuthType = "cloud_token" | "dc_pat";

/** Structured reason a Confluence call failed (GP-179/GP-180). */
export type ConfluenceErrorKind = "auth_failed" | "space_not_found" | "network";

/**
 * A repository's Confluence target (GP-179): where its docs page publishes to.
 * The credential is write-only — the only value the field can hold is the mask.
 */
export interface ConfluenceConnection {
  id: string;
  repositoryId: string;
  baseUrl: string;
  spaceKey: string;
  authType: ConfluenceAuthType;
  /** Basic-auth username for a Cloud token; null for a DC PAT. */
  email: string | null;
  /** Always "***". The credential you sent is never sent back. */
  credential: "***";
  connectionStatus: ConnectionStatus;
  verifiedAt: string | null;
  /** The published page's web URL (GP-180), once a publish has landed. */
  pageUrl: string | null;
  lastPublishedAt: string | null;
  /** Categorized kind of the last failed publish, or null. */
  lastPublishError: string | null;
  createdAt: string;
}

export interface SaveConfluenceConnectionInput {
  baseUrl: string;
  spaceKey: string;
  authType: ConfluenceAuthType;
  /** Required for `cloud_token`; ignored for a DC PAT. */
  email?: string;
  /** Write-only. Omit on an update to keep the stored one. */
  credential?: string;
}

/** Result of POST /repositories/:id/confluence/verify. */
export type ConfluenceVerifyResult =
  | { ok: true }
  | { ok: false; error: ConfluenceErrorKind };

/** Result of POST /repositories/:id/confluence/publish (GP-180). */
export type ConfluencePublishResult =
  | { ok: true; pageUrl: string | null; publishedAt: string }
  | { ok: false; error: ConfluenceErrorKind };

// --- Organizations, membership & RBAC (GP-113..GP-118) ----------------------

/** A member's role in an org. A strict hierarchy: owner > admin > member. */
export type Role = "owner" | "admin" | "member";

/** An organization the current user can see (GP-113). */
export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

/** One of the current user's org memberships, as returned inline by GET /me. */
export interface Membership {
  role: Role;
  organization: { id: string; name: string; slug: string };
}

/** A row in an org's member list (GP-118). */
export interface Member {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: Role;
  joinedAt: string;
}

/** A pending invitation (GP-116); the token is only ever in the create response. */
export interface Invitation {
  id: string;
  organizationId: string;
  email: string | null;
  role: Exclude<Role, "owner">;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

/** The create-invite response — carries the one-time token and a ready-made URL. */
export interface CreatedInvitation extends Invitation {
  token: string;
  url: string | null;
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
}

export interface CreateInvitationInput {
  role: Exclude<Role, "owner">;
  email?: string;
}

/**
 * The current user, as returned by GET /me (note: snake_case display_name).
 * GP-115: `memberships` (org + role) and the deployment's `singleOrg` flag come
 * inline so the frontend can route onboarding and switch orgs without extra calls.
 */
export interface User {
  id: string;
  email: string | null;
  display_name: string | null;
  memberships: Membership[];
  singleOrg: boolean;
}

// --- Graph / snapshots / pull requests (GP-12..GP-15) ----------------------
// The graph, annotation and tour types moved to @groundplan/canvas (GP-146) —
// one frontend definition, shared with the VS Code webview. Re-exported here
// so the rest of the app keeps importing them from @/api/types.

import type {
  Annotation,
  Graph,
  LintFinding,
  TourStep,
} from "@groundplan/canvas";

export type {
  ChangeKind,
  EdgeKind,
  AttributeDiffRow,
  NsgRule,
  RoleAssignment,
  Identity,
  NodeSource,
  GraphNode,
  GraphEdge,
  Graph,
  AnnotationType,
  AnnotationStatus,
  AnnotationProvenance,
  Annotation,
  CreateAnnotationInput,
  UpdateAnnotationInput,
  TourStep,
  LintSeverity,
  LintFinding,
} from "@groundplan/canvas";

// ---- AI studio (GP-137/138/139) --------------------------------------------

/** One in-memory `.tf` file of a studio session. */
export interface StudioFile {
  path: string;
  content: string;
}

/** One parser diagnostic of the studio parse (GP-138). */
export interface StudioParseDiagnostic {
  severity: "error" | "warning";
  message: string;
  file?: string;
  range?: { start_line: number; end_line: number };
}

/** `POST /ai-studio/parse` — snapshot + what the parser and linter had to say. */
export interface StudioParseResult {
  snapshot: Graph;
  diagnostics: {
    parse: StudioParseDiagnostic[];
    lint: LintFinding[];
  };
}
/** `k8s_namespace` is a live read of one namespace of a cluster (GP-97). */
/**
 * Which producer made a graph. The Kubernetes trio mirrors the Terraform pair
 * (GP-100): `k8s_manifest` is a repository's YAML documented from main (the HCL
 * of Kubernetes, GP-102), `k8s_rendered` is what a pull request's CI rendered
 * (its plan.json, GP-103), and `k8s_namespace` is a live cluster read (GP-97).
 */
export type SnapshotSource =
  | "plan"
  | "hcl"
  | "k8s_namespace"
  | "k8s_manifest"
  | "k8s_rendered";

/** Every source whose graph is Kubernetes — the Terraform lenses do not apply. */
const KUBERNETES_SOURCES: ReadonlySet<SnapshotSource> = new Set([
  "k8s_namespace",
  "k8s_manifest",
  "k8s_rendered",
]);

/**
 * Is this snapshot a Kubernetes one (GP-105)? The question every view that offers
 * a Terraform lens — network, IAM, adapted, C4 — has to ask before offering it.
 */
export function isKubernetesSource(source: SnapshotSource): boolean {
  return KUBERNETES_SOURCES.has(source);
}
export type PullRequestState = "open" | "closed";

/**
 * A reference a producer saw but could not resolve to a node — a Terraform
 * resource pointing at an address that was never parsed, or a Kubernetes workload
 * mounting a ConfigMap absent from its namespace. Read via the "N references could
 * not be resolved" dialog, mirroring the backend `UnresolvedReference`.
 */
export interface UnresolvedReference {
  from: string;
  ref: string;
  reason?: string;
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
  /** References that resolved to no node in the graph — read in a dialog. */
  unresolvedReferences?: UnresolvedReference[];
  /** Docs snapshots: how it was produced (GP-23/GP-26). */
  trigger?: "manual" | "auto";
}

/**
 * Snapshot list item — metadata + stats, never the graph body.
 *
 * A snapshot is *of* a repository or *of* a cluster's namespace, never both: the
 * Terraform sources carry `repositoryId`, a Kubernetes read carries `clusterId`
 * and `namespace`. A live read has no commit, so `commitSha` is empty there and
 * `ref` is the namespace.
 */
export interface SnapshotSummary {
  id: string;
  repositoryId: string | null;
  /** Set for `k8s_namespace` snapshots (GP-97); null for the Terraform sources. */
  clusterId: string | null;
  /** The namespace this snapshot is of; null for the Terraform sources. */
  namespace: string | null;
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

// --- Playground (GP-123..GP-126) -------------------------------------------

/** One in-memory HCL file — the parse endpoint's input and a draft's unit. */
export interface PlaygroundFile {
  path: string;
  content: string;
}

/**
 * The ephemeral snapshot `POST /playground/parse` returns: the same
 * graph/stats/summary a stored docs snapshot carries, minus any identity —
 * nothing was persisted, so there is no id, repository or commit.
 */
export interface PlaygroundSnapshot {
  graph: Graph;
  stats: GraphStats;
  summaryMd: string;
}

/** Draft list entry (GP-124): identity and shape, never the file contents. */
export interface PlaygroundDraftSummary {
  id: string;
  name: string;
  updatedAt: string;
  fileCount: number;
}

/** A saved playground (GP-124): the HCL sources verbatim — no snapshot. */
export interface PlaygroundDraft {
  id: string;
  userId: string;
  name: string;
  files: PlaygroundFile[];
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlaygroundDraftInput {
  name: string;
  files: PlaygroundFile[];
}

/** A rename sends `name`; a save sends `files` (always the full set). */
export interface UpdatePlaygroundDraftInput {
  name?: string;
  files?: PlaygroundFile[];
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
  /** When the PR was soft-closed (GP-109); null while open. */
  closedAt: string | null;
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

// --- Dashboard (GP-67) ------------------------------------------------------

export interface DashboardStats {
  projects: number;
  repositories: number;
  openPrs: number;
  orphanedAnnotations: number;
}

/** A recent pull request, with enough context to deep-link into its PR view. */
export interface DashboardPull {
  id: string;
  number: number;
  title: string | null;
  state: PullRequestState;
  /** The PR's branch, as CI reported it (e.g. `refs/heads/feature-x`). */
  sourceRef: string;
  /** The repository's default branch — what the PR merges into. */
  targetRef: string;
  repositoryId: string;
  repositoryUrl: string;
  projectId: string;
  updatedAt: string;
  /** Stats of the PR's latest plan snapshot; null when no plan ever parsed. */
  latestSnapshot: PullSnapshotRef | null;
  /** The latest plan contains an internet-exposed NSG (GP-43). */
  internetExposed: boolean;
  /** The latest plan contains a broad-scope high-privilege grant (GP-47). */
  privileged: boolean;
}

/** A recent documentation snapshot, with enough context to link to its docs view. */
export interface DashboardDocsSnapshot {
  id: string;
  commitSha: string;
  /** How the snapshot was produced: a push to the default branch, or by hand. */
  trigger: "auto" | "manual";
  repositoryId: string;
  repositoryUrl: string;
  projectId: string;
  createdAt: string;
}

/** A repository holding orphaned annotations — where the orphan card links to. */
export interface DashboardOrphanRepo {
  repositoryId: string;
  repositoryUrl: string;
  projectId: string;
  count: number;
}

/** Everything the home page renders, from one call (GP-67). */
export interface Dashboard {
  stats: DashboardStats;
  recentPrs: DashboardPull[];
  recentDocsSnapshots: DashboardDocsSnapshot[];
  /** Worst first, so the orphan card can link to the repository to fix. */
  orphanRepositories: DashboardOrphanRepo[];
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
  /** GP-60: `context` is the repository's read-only markdown context. */
  repository: { name: string; provider: Provider; context: string | null };
  /** GP-58: renderable annotations shown read-only on the shared diagram. */
  annotations: Annotation[];
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

// --- Annotations (GP-56..GP-59, five types as of GP-71) ---------------------

/** What one run of the AI proposer produced (GP-75). */
export interface ProposalRun {
  /** Newly stored proposals — empty when the model had nothing new to say. */
  proposals: Annotation[];
  /** How many suggestions were thrown away (invented anchors, duplicates, junk). */
  dropped: number;
  /** True when the answer was replayed from cache and no model was called. */
  cached: boolean;
}

export interface CreateProjectInput {
  name: string;
  slug: string;
  contextMd?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  /** GP-60: long-form markdown context (null clears it). */
  contextMd?: string | null;
}

export interface CreateRepositoryInput {
  provider: Provider;
  url: string;
  defaultBranch?: string;
  /** What the repository holds (GP-101). Omitted -> terraform. Set once. */
  iacType?: IacType;
  /** Optional token for cloning private repos (write-only server-side). */
  accessToken?: string;
  /** Subdirectory the IaC lives in; omitted/"" is the repository root. */
  terraformPath?: string;
}

// --- AI layer (GP-62 / GP-63 / GP-65) ---------------------------------------

/** Which kind of prose a snapshot can have generated about it. */
export type AiKind = "pr_summary" | "docs_explain";

/**
 * Whether the AI layer is configured at all. The backend's API key IS the
 * feature flag — when `enabled` is false, no AI surface renders anywhere.
 */
export interface AiStatus {
  enabled: boolean;
  /** The model generations are produced with; null when disabled. */
  model: string | null;
}

/** Prose the backend has already generated and cached for a snapshot. */
export interface AiGeneration {
  kind: AiKind;
  /** The snapshot this prose is about. */
  targetId: string;
  model: string;
  /** Markdown. */
  output: string;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
}

// --- Guided tours (GP-78 / GP-79) -------------------------------------------

/**
 * The lens a tour was written against, and which the player switches to. A change
 * tour is told on the raw diagram; a system tour on the adapted one when the repo
 * has groups worth stopping at.
 */
export type TourView = "infra" | "adapted";

export interface Tour {
  title: string;
  view: TourView;
  steps: TourStep[];
}

/** What `GET|POST /snapshots/:id/tour` answers with. */
export interface TourResponse {
  tour: Tour;
  /** The model that wrote it — shown to the reader, because they should know. */
  model: string;
  /** True when it was replayed from the cache and no model was called. */
  cached: boolean;
  /** Stops the backend threw away because they pointed at nothing. */
  dropped?: number;
}
