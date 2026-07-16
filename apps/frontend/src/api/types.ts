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

export type ChangeKind = "create" | "update" | "delete" | "noop";
/** v5: `logical` is a human-drawn relationship the code cannot express (GP-72). */
export type EdgeKind = "depends_on" | "contains" | "logical";
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
  /** v5: the human-given name (a `rename` annotation); `name` is kept beside it. */
  display_label?: string;
  /** v5: markdown bodies of the notes anchored to this node (GP-72). */
  notes?: string[];
  /** v5: this container came from a `group` annotation, not from Terraform. */
  annotation_group?: boolean;
  /** v5: resources behind a group collapsed to a single node (C4, GP-77). */
  member_count?: number;
  /**
   * v6: the resource's own labels, as the cluster reported them (GP-96).
   * Kubernetes says what a thing *is* in its labels — so the detail panel shows
   * them. Metadata only: a Secret's data never reaches a node.
   */
  labels?: Record<string, string>;
  /**
   * v7: a Kubernetes object's own content, flattened to `path → value` — e.g.
   * `spec.template.spec.containers[0].image` (GP-102). It is what lets one
   * manifest graph be diffed against another when there is no plan to ask
   * (GP-103); a Secret's values are masked in it, as they are everywhere else.
   */
  attributes?: Record<string, string>;
  /** v7: true when the attribute list was capped. */
  attributes_truncated?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** depends_on only: true when inferred from an expression reference (GP-20). */
  inferred?: boolean;
  /** v5: a logical edge's label (GP-72). */
  label?: string;
  /** v5: how many edges this one stands for after C4 aggregation (GP-77). */
  count?: number;
}

export interface Graph {
  /** 6 adds node labels — a Kubernetes namespace read (GP-96). All additive. */
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

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

export type AnnotationType = "note" | "link" | "group" | "hide" | "rename";
/** `resolved` is "accepted and live"; `proposed` awaits a human (GP-75/GP-76). */
export type AnnotationStatus = "resolved" | "orphaned" | "proposed";
export type AnnotationProvenance = "human" | "ai";

/**
 * A human annotation, anchored to Terraform addresses (graph node ids):
 *   `note`   1 anchor + markdown `body`
 *   `link`   exactly 2 anchors + optional `label` — the logical edge. An anchor
 *            may be a *group's id* instead of an address, which is how a
 *            group→group edge is expressed.
 *   `group`  1+ anchors + `label`; nests one level via `parentGroupId`
 *   `hide`   1 anchor — the node is dropped from the adapted view (GP-74)
 *   `rename` 1 anchor + `label` — the node's display label in the adapted view
 *
 * `status` is owned by reconciliation (GP-57): when an anchor's address vanishes
 * from the latest snapshot the annotation is `orphaned` and `missingAnchors`
 * records what was lost (surfaced in GP-59).
 */
export interface Annotation {
  id: string;
  repositoryId: string;
  type: AnnotationType;
  anchors: string[];
  label: string | null;
  body: string | null;
  status: AnnotationStatus;
  /** Where it came from. Permanent — an accepted AI proposal still says `ai`. */
  provenance: AnnotationProvenance;
  /**
   * Why the proposer suggested this (GP-75), in one sentence; null for human
   * annotations. A suggestion you must judge without knowing why it was made is
   * one you will rubber-stamp.
   */
  reason: string | null;
  createdFromSha: string | null;
  parentGroupId: string | null;
  missingAnchors: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAnnotationInput {
  type: AnnotationType;
  anchors: string[];
  label?: string;
  body?: string;
  parentGroupId?: string;
  createdFromSha?: string;
}

export interface UpdateAnnotationInput {
  anchors?: string[];
  label?: string;
  body?: string;
  /** Accepting a proposal (GP-76). The only way one goes live. */
  status?: "resolved";
  parentGroupId?: string | null;
}

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

/** One stop: the nodes the camera frames, and what the narrator says about them. */
export interface TourStep {
  /** Node ids. **Empty means the whole diagram** — the opening and closing stops. */
  anchors: string[];
  title: string;
  /** Markdown (prose + inline code). Untrusted model output — render, never trust. */
  body: string;
}

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
