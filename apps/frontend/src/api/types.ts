/**
 * Types mirroring the backend base models, field-for-field with the JSON the
 * API actually returns (GP-3, GP-6). Timestamps are ISO strings over the wire.
 */
import type {
  ProviderResourceSchema,
  ProviderResourceSummary,
} from "@groundplan/builder";

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

/**
 * How a credential is obtained (GP-192). Mirrors the backend's `CredentialMode`:
 * a pasted token, an OAuth connection we refresh, or an app installed on an
 * organization that mints short-lived tokens.
 */
export type CredentialMode = "pat" | "oauth2" | "installation_app";

/** What a provider can do (GP-192). The UI reads it; it never assumes it. */
export type IntegrationCapability =
  | "repo:read"
  /** Can list what a connection reaches (GP-227) — the import screen's gate. */
  | "repo:discover"
  /** Can read a repository's tree without cloning it (GP-228). */
  | "repo:tree"
  | "pr:comment"
  | "check:publish"
  | "ref:events";

/**
 * One provider as the backend registry describes it (GP-193). `connectableModes`
 * is the honest per-instance answer: empty means this deployment configured no
 * app or OAuth client for it, so only a PAT is available.
 */
export interface ProviderCatalogEntry {
  id: Provider;
  label: string;
  capabilities: IntegrationCapability[];
  credentialModes: CredentialMode[];
  connectableModes: CredentialMode[];
}

/** A connection's health (GP-192). `reconnect_required` needs a human. */
export type ConnectionStatusValue = "unverified" | "ok" | "reconnect_required";

/** An org-level provider connection. No secret is ever part of this shape. */
export interface ProviderConnection {
  id: string;
  organizationId: string;
  provider: Provider;
  mode: CredentialMode;
  name: string;
  config: {
    installationId?: number;
    account?: string | null;
    instanceUrl?: string | null;
    cloudId?: string | null;
    scope?: string | null;
  };
  status: ConnectionStatusValue;
  lastError: string | null;
  createdAt: string;
}

export interface StartConnectionInput {
  provider: Provider;
  mode: CredentialMode;
}

export interface StartConnectionResult {
  /** Send the browser here; it comes back to `/integrations/callback`. */
  authorizeUrl: string;
  redirectUri: string;
}

export interface CompleteConnectionInput {
  /** The opaque state the provider echoed back. */
  state: string;
  /** The provider's callback query, verbatim. */
  params: Record<string, string>;
}

/** Which repositories a revocation would degrade (GP-198). */
export interface ConnectionImpact {
  repositories: { id: string; url: string }[];
}

/* --- Repository discovery & import (GP-227..229) --------------------------- */

/**
 * Why discovery could not answer. Never an empty list: "your installation was
 * revoked" and "your installation covers nothing" send a user looking in very
 * different places, so each code carries its own message and remediation.
 */
export type DiscoveryErrorCode =
  | "installation_revoked"
  | "installation_not_linked"
  | "multiple_connections"
  | "insufficient_permissions"
  | "unavailable";

/** How this repository is already attached in this org (empty = never). */
export interface RepoAttachment {
  repoId: string;
  projectId: string;
  kind: IacType;
  path: string;
}

/** A repository as the provider describes it, plus what we already know of it. */
export interface DiscoveredRepository {
  externalId: string;
  fullName: string;
  owner: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  updatedAt: string | null;
  /**
   * Non-empty does **not** mean "cannot be imported": a monorepo is legitimately
   * attached once per kind (GP-100).
   */
  attachments: RepoAttachment[];
}

export interface DiscoveryPage {
  /** Which connection answered — echoed so a picker can stay in sync. */
  credentialId: string;
  repositories: DiscoveredRepository[];
  /** Opaque; pass it back verbatim. Null on the last page. */
  nextCursor: string | null;
  /** How many match the current search, across every page. */
  total: number;
}

/** What a repository holds, as detection reports it (GP-228). */
export interface RepoKindDetection {
  fullName: string;
  /** Null when we will not guess — including the monorepo case. */
  kind: IacType | null;
  /** `high` only when one family of signals was found in a whole tree. */
  confidence: "high" | "low";
  /** Paths that decided it, shown to the user verbatim. */
  evidence: string[];
  /** A directory to pre-fill the path field with, or null. */
  suggestedPath: string | null;
  /** The provider truncated the tree, so nothing here is certain. */
  truncated: boolean;
}

/** One repository to attach. `kind` is required — it is immutable afterwards. */
export interface ImportItem {
  fullName?: string;
  cloneUrl?: string;
  kind: IacType;
  path?: string;
  defaultBranch?: string;
}

export interface ImportRepositoriesInput {
  projectId: string;
  credentialId?: string;
  installationId?: number;
  items: ImportItem[];
}

/**
 * Partial success is the contract (GP-229): every item is accounted for, and a
 * duplicate is `skipped` rather than reported as an error.
 */
export interface ImportResult {
  imported: CreatedRepository[];
  skipped: { item: ImportItem; reason: string }[];
  failed: { item: ImportItem; error: string; code: AttachErrorCode }[];
}

/** Why a repository could not be attached — one message, one remediation. */
export type AttachErrorCode =
  | "no_credential_resolved"
  | "installation_does_not_cover_repo"
  | "insufficient_permissions"
  | "unreachable";

export interface RepositoryCredentialResult {
  id: string;
  credentialId: string | null;
  authMode: CredentialMode | null;
}

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
  /** GP-192: the org connection authenticating this repo, or null for the PAT. */
  credentialId: string | null;
  /** GP-192: which credential strategy is actually in force, or null for none. */
  authMode: CredentialMode | null;
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
  /** Switch onto an org connection; `null` goes back to the PAT (GP-229). */
  credentialId?: string | null;
  /** A GitHub App installation id, the form the connect flows speak. */
  installationId?: number;
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

// --- Confluence export (GP-179..GP-182) --------------------------------------

/**
 * How the Confluence credential authenticates: a Cloud API token, a Data Center
 * PAT, or — GP-197 — an Atlassian OAuth (3LO) grant whose refresh token the
 * server renews. Only the first two are ever entered by hand.
 */
export type ConfluenceAuthType = "cloud_token" | "dc_pat" | "oauth";

/** Structured reason a Confluence call failed (GP-179/GP-180). */
export type ConfluenceErrorKind = "auth_failed" | "space_not_found" | "network";

/**
 * A repository's Confluence publish target (GP-179; re-homed by GP-183): the org
 * Integration that authenticates it and the space its docs land in. No
 * credential travels on a target — that lives on the Integration.
 */
export interface ConfluenceConnection {
  id: string;
  repositoryId: string;
  integrationId: string;
  spaceKey: string;
  /** The published page's web URL (GP-180), once a publish has landed. */
  pageUrl: string | null;
  lastPublishedAt: string | null;
  /** Categorized kind of the last failed publish, or null. */
  lastPublishError: string | null;
  createdAt: string;
}

export interface SaveConfluenceConnectionInput {
  /** An org Atlassian integration of this repo's org. */
  integrationId: string;
  spaceKey: string;
}

/** Result of POST /repositories/:id/confluence/publish (GP-180). */
export type ConfluencePublishResult =
  | { ok: true; pageUrl: string | null; publishedAt: string }
  | { ok: false; error: ConfluenceErrorKind };

// --- Organization integrations (GP-183) --------------------------------------

/** The kind of external system an integration connects to. */
export type IntegrationType = "atlassian";

/** Non-secret, type-specific configuration of an Atlassian integration. */
export interface AtlassianIntegrationConfig {
  baseUrl: string;
  authType: ConfluenceAuthType;
  /** Basic-auth username for a Cloud token; null for a DC PAT or OAuth. */
  email: string | null;
  /** OAuth only (GP-197): the Atlassian site id behind the API gateway. */
  cloudId?: string | null;
  /** OAuth only: the site's human URL — what a person should be shown. */
  siteUrl?: string | null;
}

/**
 * An org-level integration (GP-183): an external credential configured once per
 * org and attached by N repositories. The credential is write-only — the field
 * only ever holds the mask.
 */
export interface Integration {
  id: string;
  organizationId: string;
  type: IntegrationType;
  name: string;
  config: AtlassianIntegrationConfig;
  /** Always "***". The credential you sent is never sent back. */
  credential: "***";
  connectionStatus: ConnectionStatus;
  /** Why the last check failed, or null (GP-197) — never a credential. */
  lastError: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

/** One integration type and whether this deployment can connect it by OAuth. */
export interface IntegrationOAuthProvider {
  type: IntegrationType;
  connectable: boolean;
}

/** Body of POST /orgs/:orgId/integrations. */
export interface CreateIntegrationInput {
  type: IntegrationType;
  name: string;
  baseUrl: string;
  authType: ConfluenceAuthType;
  /** Required for `cloud_token`; omitted for a DC PAT. */
  email?: string;
  credential: string;
}

/** Body of PATCH /orgs/:orgId/integrations/:id — every field optional. */
export interface UpdateIntegrationInput {
  name?: string;
  baseUrl?: string;
  authType?: ConfluenceAuthType;
  email?: string;
  /** Write-only. Omit to keep the stored credential. */
  credential?: string;
}

/** Result of POST /orgs/:orgId/integrations/:id/verify. */
export type IntegrationVerifyResult =
  | { ok: true }
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
  AttributeDiffRow,
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

/**
 * A saved playground (GP-124): the HCL sources verbatim — no snapshot — and
 * since GP-247 whatever the Build Editor has on its canvas. Two documents in
 * one draft, neither derived from the other: the builder is one-way (ADR #5),
 * so generating files from a composition does not make them the same thing.
 */
export interface PlaygroundDraft {
  id: string;
  userId: string;
  name: string;
  files: PlaygroundFile[];
  composition?: BuilderGraphInput | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlaygroundDraftInput {
  name: string;
  files: PlaygroundFile[];
  composition?: BuilderGraphInput | null;
}

/** A rename sends `name`; a save sends `files` (always the full set). */
export interface UpdatePlaygroundDraftInput {
  name?: string;
  files?: PlaygroundFile[];
  /** `null` clears it: an emptied canvas is not an untouched one. */
  composition?: BuilderGraphInput | null;
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
  /**
   * GP-203: what changed about compliance between the two versions — the same
   * comparison a pull request makes, so "resolved since last month" and
   * "resolved by this PR" are the same fact computed the same way.
   */
  policy: PolicyDelta;
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
  /**
   * GP-203: where each repository stands against the policy, worst first. A
   * repository whose main was never documented is *absent* rather than passing —
   * this list says what is known.
   */
  compliance: DashboardCompliance[];
  /**
   * GP-207: where each repository stands against reality, stale first. Same
   * posture as `compliance` — a repository nobody measured is absent.
   */
  drift: DashboardDrift[];
}

/** One repository's compliance state, from its current documentation of main. */
export interface DashboardCompliance {
  repositoryId: string;
  repositoryUrl: string;
  projectId: string;
  /** The documentation snapshot the verdict is about. */
  snapshotId: string;
  commitSha: string;
  status: PolicyStatus;
  counts: {
    error: number;
    warning: number;
    info: number;
    waived: number;
    total: number;
  };
  /** How many rules actually produced a verdict — 0 means nothing was checked. */
  checkedRules: number;
  evaluatedAt: string;
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
  /** GP-203: whether this link publishes the compliance state. Off by default. */
  includePolicy: boolean;
  createdAt: string;
}

export interface CreateShareLinkInput {
  kind: ShareKind;
  /** Required when kind = "snapshot". */
  snapshotId?: string;
  /** GP-203: publish the compliance state on this link. Off unless asked. */
  includePolicy?: boolean;
}

/** The credential-free snapshot payload served on public routes. */
export interface PublicSnapshotView {
  kind: ShareKind;
  /**
   * GP-203: the compliance state, and only when the link's creator opted in —
   * null otherwise, the same posture AI content takes on a public link.
   */
  policy: PolicyReport | null;
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
  /**
   * GP-229: the same credential vocabulary the update path has. When an
   * installation covers the repository neither of these is needed — the server
   * resolves it from the owner — but naming one removes the ambiguity.
   */
  credentialId?: string | null;
  installationId?: number;
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

/**
 * Whether Build mode exists on this deployment (GP-131). `BUILDER_ENABLED` is
 * the whole flag: false and the playground renders no Build surface at all.
 */
export interface BuilderStatus {
  enabled: boolean;
}

/**
 * A composed builder graph on the wire. Mirrors `BuilderGraph` from
 * `@groundplan/builder` — the canvas holds the real type; this is what the
 * generation request carries.
 */
export interface BuilderGraphInput {
  nodes: {
    id: string;
    type: string;
    name: string;
    /**
     * `data` writes a lookup instead of a declaration (GP-248); `variable`
     * writes an input the composition takes in (GP-249).
     */
    mode?: "resource" | "data" | "variable";
    attributes: Record<string, string | number | boolean | string[]>;
    position: { x: number; y: number };
    /** What it is drawn inside (GP-247). Ignored by generation. */
    parentId?: string;
    custom?: boolean;
  }[];
  references: {
    from: string;
    to: string;
    attribute: string;
    targetAttribute?: string;
  }[];
}

/**
 * The resource catalog (GP-237). The schema shapes themselves live in
 * `@groundplan/builder` (`ProviderResourceSchema`, `ProviderResourceSummary`) —
 * the package both sides already share — so only the envelopes are mirrored
 * here. What they all carry is a version and a date: a catalog surface that did
 * not say which provider version it is showing, and when it was read, would be
 * the one place in this product that hides its own staleness.
 */
export interface CatalogProvider {
  /** `hashicorp/azurerm`. */
  provider: string;
  namespace: string;
  name: string;
  /** The version being served; null while nothing has been extracted yet. */
  version: string | null;
  /** When that version was read. ISO string, null while warming. */
  readAt: string | null;
  /** The newest stable version the registry watcher saw, if it ever looked. */
  latestKnownVersion: string | null;
  lastCheckedAt: string | null;
  status: "ready" | "warming";
}

export interface CatalogProviders {
  /** `disabled` = this deployment makes no outbound catalog call; pinned. */
  refresh: "auto" | "disabled";
  providers: CatalogProvider[];
  /** Providers with stored schemas that the allowlist no longer offers. */
  retired: string[];
}

export interface CatalogResourceList {
  provider: string;
  version: string;
  readAt: string;
  /** How many types the filter matched, not how many were returned. */
  total: number;
  limit: number;
  offset: number;
  resources: ProviderResourceSummary[];
}

export interface CatalogResourceSchemaResponse {
  provider: string;
  version: string;
  readAt: string;
  schema: ProviderResourceSchema;
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

// --- Policy engine (GP-199..GP-204) -----------------------------------------

/**
 * How loudly a rule speaks. Not the studio lint's `info | warn | high`: a policy
 * is a decision an organization made, so its levels are the ones a decision is
 * expressed in.
 */
export type PolicySeverity = "error" | "warning" | "info";

/** What a rule can judge. A rule outside its target is *not applicable*, never a pass. */
export type PolicyTarget = "terraform" | "kubernetes";

/** The verdict of a report, from the worst violation nobody has waived. */
export type PolicyStatus = "passing" | "warnings" | "failing";

/** One rule's configuration, as a scope chose to state it. Every field optional. */
export interface PolicyRuleOverride {
  enabled?: boolean;
  severity?: PolicySeverity;
  params?: Record<string, unknown>;
}

/** A configuration document: rule id → what that scope changes about the rule. */
export type PolicyConfig = Record<string, PolicyRuleOverride>;

/**
 * A catalogue rule with the configuration it would run under in this scope.
 * `configured` is what makes an inherited value and a deliberate override
 * distinguishable on screen — without it, "same as the org" and "set to the
 * same thing as the org" look identical, and only one of them survives an org
 * change.
 */
export interface PolicyCatalogEntry {
  ruleId: string;
  title: string;
  description: string;
  enabled: boolean;
  severity: PolicySeverity;
  /** False when the rule cannot judge this repository's kind of graph. */
  applicable: boolean;
  params?: Record<string, unknown>;
  defaultSeverity: PolicySeverity;
  defaultEnabled: boolean;
  appliesTo: PolicyTarget[];
  configured: boolean;
}

/** What `GET|PUT /policy-config` answers with (organization scope). */
export interface OrgPolicyConfig {
  scope: "organization";
  rules: PolicyConfig;
  catalog: PolicyCatalogEntry[];
}

/** What `GET|PUT /repositories/:id/policy-config` answers with. */
export interface RepositoryPolicyConfig {
  scope: "repository";
  /** The organization's document — what this repository inherits. */
  inherited: PolicyConfig;
  /** This repository's own document, or null when it inherits everything. */
  override: PolicyConfig | null;
  /** The two folded together — what it is actually evaluated under. */
  rules: PolicyConfig;
  catalog: PolicyCatalogEntry[];
}

/** One thing a rule found, anchored to a resource address (a node id). */
export interface PolicyViolation {
  ruleId: string;
  severity: PolicySeverity;
  address: string;
  message: string;
  /** What to do about it — always present; a finding with no remedy is noise. */
  hint: string;
  /** GP-204: set when a waiver suspends this violation. Never hidden, just marked. */
  waiver?: { id: string; reason: string; expiresAt: string | null };
}

/** How one rule was configured for the evaluation that produced a report. */
export interface EffectiveRule {
  ruleId: string;
  enabled: boolean;
  severity: PolicySeverity;
  applicable: boolean;
  params?: Record<string, unknown>;
}

/** The evaluation of one snapshot: what was checked, and what it found. */
export interface PolicyReport {
  version: 1 | 2;
  target: PolicyTarget;
  status: PolicyStatus;
  counts: {
    error: number;
    warning: number;
    info: number;
    waived: number;
    total: number;
  };
  violations: PolicyViolation[];
  /** Every catalogue rule with the configuration it ran under — including the
   * ones that were off or not applicable, so "not checked" stays visible. */
  rules: EffectiveRule[];
}

/** How a pull request's violations compare with the documentation of main. */
export interface PolicyDelta {
  version: 1;
  added: PolicyViolation[];
  resolved: PolicyViolation[];
  preexisting: PolicyViolation[];
  /** The verdict on the **new** violations only. Informative in v1. */
  status: PolicyStatus;
  /** Null when there was no documentation of main to compare against. */
  baseSnapshotId: string | null;
}

/** What `GET /snapshots/:id/policy` answers with. */
export interface SnapshotPolicy {
  snapshotId: string;
  report: PolicyReport;
  /** Null for a report *of* main — it has nothing to be compared against. */
  delta: PolicyDelta | null;
  summaryMd: string;
}

// --- Waivers (GP-204) --------------------------------------------------------

/** `orphaned` mirrors the annotation layer: the resource it names is gone. */
export type PolicyWaiverStatus = "active" | "orphaned";

/** What was done to a waiver — the trail, and the base of a future audit log. */
export type PolicyWaiverAction = "created" | "extended" | "revoked";

/**
 * An exemption from one rule on one resource. A waived violation is still
 * evaluated, still reported and still listed — marked, counted apart and greyed.
 */
export interface PolicyWaiver {
  id: string;
  repositoryId: string;
  ruleId: string;
  address: string;
  /** Mandatory. A waiver nobody justified is a rule nobody enforces. */
  reason: string;
  status: PolicyWaiverStatus;
  /** Null = no end date. Past = the violation is active again next report. */
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyWaiverEvent {
  id: string;
  waiverId: string;
  repositoryId: string;
  action: PolicyWaiverAction;
  reason: string | null;
  expiresAt: string | null;
  actorId: string | null;
  createdAt: string;
}

export interface CreateWaiverInput {
  ruleId: string;
  address: string;
  reason: string;
  /** ISO-8601; omit or null for a waiver with no end date. */
  expiresAt?: string | null;
}

// --- Drift (GP-206 / GP-207) -------------------------------------------------

/**
 * What reality did to a resource. There is no `create`: a resource created
 * outside Terraform is not in the state, so a refresh cannot see it — that is
 * the reality snapshot's question.
 */
export type DriftChange = "update" | "delete";

/** One resource the world changed without the code being asked. */
export interface DriftedResource {
  address: string;
  type: string;
  provider: string | null;
  module_path: string[];
  change: DriftChange;
  /** Masked before→after rows, from the same differ the plan view uses. */
  attribute_diff: AttributeDiffRow[];
  attribute_diff_truncated?: boolean;
}

/** One measurement of an estate against its code. */
export interface DriftReport {
  version: 1 | 2;
  counts: { updated: number; deleted: number; total: number };
  resources: DriftedResource[];
  /**
   * GP-207: what the drift does to compliance, read with reality as the head and
   * the code as the base — so `added` means **introduced outside IaC**.
   * Undefined when there was no comparable verdict of the code; undefined, never
   * empty, because "nothing was introduced" and "nobody could check" differ.
   */
  policy?: PolicyDelta;
}

/**
 * A measurement, plus the two facts a reader needs before believing it: when it
 * was taken, and whether main has moved since (`stale`).
 */
export interface DriftState {
  id: string;
  repositoryId: string;
  ref: string;
  /** The sha of main that was measured. */
  commitSha: string;
  /** The documentation snapshot it lines up with; null when main had no diagram. */
  snapshotId: string | null;
  /** The sha main is documented at now; null when it never was. */
  baseCommitSha: string | null;
  /** True when main moved since — re-measure before believing it. */
  stale: boolean;
  measuredAt: string;
  report: DriftReport;
  summaryMd: string;
}

/**
 * One repository's standing against reality (GP-207), from its newest drift
 * measurement. A repository nobody has measured is absent from the list — drift
 * is opt-in, and "0 drifted" for an estate nobody refreshed would be the most
 * reassuring lie in the product.
 */
export interface DashboardDrift {
  repositoryId: string;
  repositoryUrl: string;
  projectId: string;
  ref: string;
  /** The sha that was measured. */
  commitSha: string;
  /** The sha main is documented at now; null when it never was. */
  baseCommitSha: string | null;
  /** True when main moved since — the count answers a question nobody asked. */
  stale: boolean;
  drifted: number;
  deleted: number;
  /** Violations that exist in the cloud and not in the code (GP-207). */
  outsideIac: number;
  measuredAt: string;
}

// --- Reality vs Code (GP-208 / GP-209) ---------------------------------------

export interface ReconcileCounts {
  /** In the cloud, not in the code — nobody wrote these down. */
  unmanaged: number;
  /** In the code, not in the cloud. */
  notApplied: number;
  /** In both, disagreeing on an attribute they both recorded. */
  divergent: number;
  matching: number;
}

/** Which snapshot each side of the comparison came from, and how old it is. */
export interface ReconcileSide {
  snapshotId: string;
  ref: string;
  commitSha: string;
}

/**
 * The cloud compared with the code (GP-209). Both sides are always named: a
 * comparison whose age you cannot see is one a reader assumes is live, and this
 * one is exactly as old as the last `push-state`.
 */
export interface Reconciliation {
  version: 1;
  /** Coloured for the canvas; the labels a human reads are the panel's. */
  graph: Graph;
  counts: ReconcileCounts;
  unmanaged: string[];
  notApplied: string[];
  divergent: string[];
  summaryMd: string;
  code: ReconcileSide & { createdAt: string };
  reality: ReconcileSide & {
    /** When the state was read — the age of everything on the cloud side. */
    observedAt: string;
    terraformVersion: string | null;
  };
}
