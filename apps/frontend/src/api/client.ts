/**
 * The single place where HTTP happens. A thin, typed wrapper over `fetch`:
 * base URL from runtime config, JSON handling, bearer-token injection, and a
 * single ApiError for non-2xx responses.
 */
import { getConfig } from "@/config";

import type {
  AiGeneration,
  AiKind,
  AiStatus,
  Annotation,
  AnnotationStatus,
  Cluster,
  ClusterVerifyResult,
  CreateAnnotationInput,
  CreateClusterInput,
  ProposalRun,
  AppWebhookToken,
  CreatedRepository,
  IngestionSettings,
  CreateProjectInput,
  CreateRepositoryInput,
  CreateShareLinkInput,
  CreateOrganizationInput,
  CreateInvitationInput,
  CreatedInvitation,
  Dashboard,
  IngestionEvent,
  IacType,
  Invitation,
  Member,
  Organization,
  CreatePlaygroundDraftInput,
  PlaygroundDraft,
  PlaygroundDraftSummary,
  PlaygroundFile,
  PlaygroundSnapshot,
  Role,
  UpdatePlaygroundDraftInput,
  UpdateClusterInput,
  Project,
  PublicSnapshotView,
  PullDetail,
  PullSummary,
  Repository,
  RepositoryActivity,
  ShareLink,
  Snapshot,
  SnapshotSource,
  SnapshotDiff,
  SnapshotSummary,
  StudioFile,
  StudioParseResult,
  TourResponse,
  UpdateAnnotationInput,
  UpdateProjectInput,
  UpdateRepositoryInput,
  User,
  VerifyResult,
  ConfluenceConnection,
  ConfluencePublishResult,
  SaveConfluenceConnectionInput,
  Integration,
  CreateIntegrationInput,
  UpdateIntegrationInput,
  IntegrationVerifyResult,
} from "./types";

/** API origin from runtime config (`""` = same-origin). Read lazily so the
 * value reflects `config.json` loaded at startup, not import-time defaults. */
function apiRoot(): string {
  return getConfig().apiUrl;
}
/** `${origin}/api/v1` — the base every request path is appended to. */
function apiBase(): string {
  return `${apiRoot()}/api/v1`;
}

/** One entry of a 422's per-field details (e.g. an offending playground file). */
export type ApiFieldError = { field: string; message: string };

/** Thrown for any non-2xx response; carries the HTTP status and server message. */
export class ApiError extends Error {
  readonly status: number;
  /** Per-field details when the server sent them (validation 422s). */
  readonly fields?: ApiFieldError[];
  constructor(status: number, message: string, fields?: ApiFieldError[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    if (fields) this.fields = fields;
  }
}

type TokenProvider = () => string | null | undefined;
type UnauthorizedHandler = () => void;

let tokenProvider: TokenProvider = () => null;
let unauthorizedHandler: UnauthorizedHandler = () => {};

/** Wire up how the client obtains the bearer token (set by the login story). */
export function setAuthTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

/** Called once whenever the API answers 401 (wired by the login story). */
export function setOnUnauthorized(handler: UnauthorizedHandler): void {
  unauthorizedHandler = handler;
}

type ActiveOrgProvider = () => string | null | undefined;
let activeOrgProvider: ActiveOrgProvider = () => null;

/**
 * Wire up how the client learns the active org id (set by the OrgProvider,
 * GP-117). Every org-scoped call goes to `/orgs/:orgId/...`; global calls (`/me`,
 * `/orgs`, `/invitations/accept`, `/settings`, `/ai/status`, `/public`) do not.
 */
export function setActiveOrgProvider(provider: ActiveOrgProvider): void {
  activeOrgProvider = provider;
}

/** The active org id, or throw — org-scoped calls must not fire without one. */
function activeOrg(): string {
  const orgId = activeOrgProvider();
  if (!orgId) throw new ApiError(0, "no active organization selected");
  return orgId;
}

/** Same as `request`, but under the active org's `/orgs/:orgId` prefix. */
function orgRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(`/orgs/${encode(activeOrg())}${path}`, options);
}

type RequestOptions = {
  method?: string;
  body?: unknown;
};

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};

  const token = tokenProvider();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${apiBase()}${path}`, {
    method: options.method ?? "GET",
    headers,
    body,
  });

  if (response.status === 401) {
    unauthorizedHandler();
  }

  if (!response.ok) {
    throw await apiErrorFrom(response);
  }

  // 204 No Content (e.g. DELETE) carries no body.
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function apiErrorFrom(response: Response): Promise<ApiError> {
  let message =
    response.statusText || `Request failed with status ${response.status}`;
  let fields: ApiFieldError[] | undefined;
  try {
    const data: unknown = await response.json();
    if (data && typeof data === "object") {
      if (typeof (data as { message?: unknown }).message === "string") {
        message = (data as { message: string }).message;
      }
      // Validation 422s carry per-field details; keep them for the callers
      // that can point at the offender (e.g. the playground file panel).
      const raw = (data as { fields?: unknown }).fields;
      if (Array.isArray(raw)) {
        fields = raw.filter(
          (f): f is ApiFieldError =>
            !!f &&
            typeof f === "object" &&
            typeof (f as { field?: unknown }).field === "string" &&
            typeof (f as { message?: unknown }).message === "string",
        );
      }
    }
  } catch {
    // Non-JSON body — fall back to the status text.
  }
  return new ApiError(response.status, message, fields);
}

const encode = encodeURIComponent;

/**
 * Absolute URL + auth header for the one caller that streams outside
 * `request` (the AI studio chat, GP-140 — the AI SDK's transport owns that
 * fetch). Everything else keeps going through `request`.
 */
export function streamingEndpoint(path: string): {
  url: string;
  headers: Record<string, string>;
} {
  const token = tokenProvider();
  return {
    url: `${apiBase()}${path}`,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  };
}

export type ExportFormat = "svg" | "png" | "drawio";
export type ExportScope = "full" | "changes";
/** The lens a draw.io export renders; SVG/PNG always render "infra". */
export type ExportView = "infra" | "network" | "iam";

/**
 * Fetch a rendered snapshot export (GP-37) as a Blob. The export endpoints sit
 * behind bearer auth, so this goes through the same token-injecting path as the
 * JSON client rather than a bare <img>/<a> (which would omit the token).
 */
export async function getSnapshotExport(
  id: string,
  format: ExportFormat,
  scope: ExportScope = "full",
  views: ExportView[] = ["infra"],
): Promise<Blob> {
  const headers: Record<string, string> = {};
  const token = tokenProvider();
  if (token) headers.Authorization = `Bearer ${token}`;
  const params = new URLSearchParams();
  if (scope === "changes") params.set("scope", "changes");
  if (format === "drawio" && views.join() !== "infra") params.set("views", views.join(","));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const response = await fetch(
    `${apiBase()}/orgs/${encode(activeOrg())}/snapshots/${encode(id)}/export.${format}${query}`,
    { headers },
  );
  if (response.status === 401) unauthorizedHandler();
  if (!response.ok) {
    throw await apiErrorFrom(response);
  }
  return response.blob();
}

export function listProjects(): Promise<Project[]> {
  return orgRequest<Project[]>("/projects");
}

export function createProject(input: CreateProjectInput): Promise<Project> {
  return orgRequest<Project>("/projects", { method: "POST", body: input });
}

export function getProject(id: string): Promise<Project> {
  return orgRequest<Project>(`/projects/${encode(id)}`);
}

/** Update a project's name and/or its long-form context (GP-60). */
export function updateProject(
  id: string,
  input: UpdateProjectInput,
): Promise<Project> {
  return orgRequest<Project>(`/projects/${encode(id)}`, {
    method: "PATCH",
    body: input,
  });
}

export function deleteProject(id: string): Promise<void> {
  return orgRequest<void>(`/projects/${encode(id)}`, { method: "DELETE" });
}

export function listRepositories(projectId: string): Promise<Repository[]> {
  return orgRequest<Repository[]>(`/projects/${encode(projectId)}/repositories`);
}

/** Freshness signal for every repo in a project — one call for the whole list. */
export function listRepositoryActivity(
  projectId: string,
): Promise<RepositoryActivity[]> {
  return orgRequest<RepositoryActivity[]>(
    `/projects/${encode(projectId)}/repositories/activity`,
  );
}

export function createRepository(
  projectId: string,
  input: CreateRepositoryInput,
): Promise<CreatedRepository> {
  return orgRequest<CreatedRepository>(
    `/projects/${encode(projectId)}/repositories`,
    { method: "POST", body: input },
  );
}

export function getRepository(id: string): Promise<Repository> {
  return orgRequest<Repository>(`/repositories/${encode(id)}`);
}

export function updateRepository(
  id: string,
  input: UpdateRepositoryInput,
): Promise<Repository> {
  return orgRequest<Repository>(`/repositories/${encode(id)}`, {
    method: "PATCH",
    body: input,
  });
}

export function verifyRepository(id: string): Promise<VerifyResult> {
  return orgRequest<VerifyResult>(`/repositories/${encode(id)}/verify`, {
    method: "POST",
  });
}

export function deleteRepository(id: string): Promise<void> {
  return orgRequest<void>(`/repositories/${encode(id)}`, { method: "DELETE" });
}

// --- Organization integrations (GP-183) --------------------------------------

/** The org's integrations (GP-183); readable by any member (masked). */
export function listIntegrations(): Promise<Integration[]> {
  return orgRequest<Integration[]>(`/integrations`);
}

/** Create an org integration; the server verifies the credential on save. */
export function createIntegration(
  input: CreateIntegrationInput,
): Promise<Integration> {
  return orgRequest<Integration>(`/integrations`, { method: "POST", body: input });
}

/** Edit an org integration; re-verified on save. Omit the credential to keep it. */
export function updateIntegration(
  id: string,
  input: UpdateIntegrationInput,
): Promise<Integration> {
  return orgRequest<Integration>(`/integrations/${encode(id)}`, {
    method: "PATCH",
    body: input,
  });
}

export function verifyIntegration(id: string): Promise<IntegrationVerifyResult> {
  return orgRequest<IntegrationVerifyResult>(
    `/integrations/${encode(id)}/verify`,
    { method: "POST" },
  );
}

/** Delete an org integration; the server answers 409 if a repo still uses it. */
export function deleteIntegration(id: string): Promise<void> {
  return orgRequest<void>(`/integrations/${encode(id)}`, { method: "DELETE" });
}

// --- Confluence export (GP-179..GP-183) --------------------------------------

/** The repository's Confluence target, or null when none is configured. */
export async function getConfluenceConnection(
  repositoryId: string,
): Promise<ConfluenceConnection | null> {
  try {
    return await orgRequest<ConfluenceConnection>(
      `/repositories/${encode(repositoryId)}/confluence`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Create-or-replace the target (an org integration + a space key). */
export function saveConfluenceConnection(
  repositoryId: string,
  input: SaveConfluenceConnectionInput,
): Promise<ConfluenceConnection> {
  return orgRequest<ConfluenceConnection>(
    `/repositories/${encode(repositoryId)}/confluence`,
    { method: "PUT", body: input },
  );
}

export function deleteConfluenceConnection(repositoryId: string): Promise<void> {
  return orgRequest<void>(`/repositories/${encode(repositoryId)}/confluence`, {
    method: "DELETE",
  });
}

/** Publish the latest docs snapshot to the configured page (GP-180). */
export function publishToConfluence(
  repositoryId: string,
): Promise<ConfluencePublishResult> {
  return orgRequest<ConfluencePublishResult>(
    `/repositories/${encode(repositoryId)}/confluence/publish`,
    { method: "POST" },
  );
}

/**
 * Rotate the repository's webhook token. The response carries the fresh token,
 * shown once — the old one stops working the moment this resolves.
 */
export function regenerateWebhookToken(id: string): Promise<CreatedRepository> {
  return orgRequest<CreatedRepository>(`/repositories/${encode(id)}/webhook-token`, {
    method: "POST",
  });
}

// --- Kubernetes clusters (GP-95) --------------------------------------------

/** Every attached cluster. A cluster is nobody's child — there is nothing to scope by. */
export function listClusters(): Promise<Cluster[]> {
  return orgRequest<Cluster[]>("/clusters");
}

/**
 * Attach a cluster. The kubeconfig goes up once and never comes back — the
 * response masks it, which is why `Cluster.kubeconfig` is typed as the mask.
 */
export function createCluster(input: CreateClusterInput): Promise<Cluster> {
  return orgRequest<Cluster>("/clusters", { method: "POST", body: input });
}

export function updateCluster(
  id: string,
  input: UpdateClusterInput,
): Promise<Cluster> {
  return orgRequest<Cluster>(`/clusters/${encode(id)}`, {
    method: "PATCH",
    body: input,
  });
}

export function verifyCluster(id: string): Promise<ClusterVerifyResult> {
  return orgRequest<ClusterVerifyResult>(`/clusters/${encode(id)}/verify`, {
    method: "POST",
  });
}

export function deleteCluster(id: string): Promise<void> {
  return orgRequest<void>(`/clusters/${encode(id)}`, { method: "DELETE" });
}

export function getCluster(id: string): Promise<Cluster> {
  return orgRequest<Cluster>(`/clusters/${encode(id)}`);
}

// --- Kubernetes namespaces & snapshots (GP-97) ------------------------------

/** The cluster's namespaces, read live. 502 when the cluster is unreachable. */
export function listClusterNamespaces(clusterId: string): Promise<string[]> {
  return orgRequest<{ namespaces: string[] }>(
    `/clusters/${encode(clusterId)}/namespaces`,
  ).then((res) => res.namespaces);
}

/**
 * Read the namespace and store it as a snapshot. Always user-triggered: a diagram
 * of a live cluster is a read of somebody's production, and it happens when they
 * ask for it. 409 while one is already running.
 */
export function generateNamespaceSnapshot(
  clusterId: string,
  namespace: string,
): Promise<Snapshot> {
  return orgRequest<Snapshot>(
    `/clusters/${encode(clusterId)}/namespaces/${encode(namespace)}/snapshots`,
    { method: "POST", body: {} },
  );
}

/** This namespace's snapshots, newest first (GP-26's shape, for a cluster). */
export function listNamespaceSnapshots(
  clusterId: string,
  namespace: string,
): Promise<SnapshotSummary[]> {
  return orgRequest<SnapshotSummary[]>(
    `/clusters/${encode(clusterId)}/namespaces/${encode(namespace)}/snapshots`,
  );
}

/**
 * Absolute URL CI posts plan.json to (GP-5). Uses the configured API origin, or
 * the current origin in dev — so the copy-paste snippet is always usable.
 */
export function webhookUrl(repositoryId: string): string {
  const origin =
    apiRoot() || (typeof window !== "undefined" ? window.location.origin : "");
  return `${origin}/api/v1/webhooks/ci/${repositoryId}`;
}

// --- App-wide ingestion settings --------------------------------------------

/** Whether an app-wide CI token is set, and when — never the value itself. */
export function getIngestionSettings(): Promise<IngestionSettings> {
  return request<IngestionSettings>("/settings/ingestion");
}

/**
 * Generate or rotate the app-wide CI token. The response carries it once; a
 * previously issued app-wide token stops working the moment this resolves.
 */
export function rotateAppWebhookToken(): Promise<AppWebhookToken> {
  return request<AppWebhookToken>("/settings/ingestion/webhook-token", {
    method: "POST",
  });
}

/** Revoke the app-wide CI token. Per-repository tokens keep working. */
export function clearAppWebhookToken(): Promise<void> {
  return request<void>("/settings/ingestion/webhook-token", { method: "DELETE" });
}

// --- Pull requests & graph snapshots (GP-12 / GP-14 / GP-17 / GP-18) --------

export function listPulls(repositoryId: string): Promise<PullSummary[]> {
  return orgRequest<PullSummary[]>(`/repositories/${encode(repositoryId)}/pulls`);
}

/**
 * The last CI webhooks Groundplan received for a repository (GP-5), newest first.
 * The setup page (GP-111) reads the most recent to show whether CI has reached us.
 */
export function listEvents(repositoryId: string): Promise<IngestionEvent[]> {
  return orgRequest<IngestionEvent[]>(`/repositories/${encode(repositoryId)}/events`);
}

export function getPull(
  repositoryId: string,
  number: number,
): Promise<PullDetail> {
  return orgRequest<PullDetail>(
    `/repositories/${encode(repositoryId)}/pulls/${number}`,
  );
}

export function listSnapshots(
  repositoryId: string,
  opts: {
    /** A repository's snapshots come from whichever producer it has (GP-102). */
    source?: Exclude<SnapshotSource, "k8s_namespace">;
    prNumber?: number;
  } = {},
): Promise<SnapshotSummary[]> {
  const params = new URLSearchParams();
  if (opts.source) params.set("source", opts.source);
  if (opts.prNumber !== undefined) params.set("pr_number", String(opts.prNumber));
  const query = params.toString();
  const querySuffix = query ? `?${query}` : "";
  return orgRequest<SnapshotSummary[]>(
    `/repositories/${encode(repositoryId)}/snapshots${querySuffix}`,
  );
}

export function getSnapshot(id: string): Promise<Snapshot> {
  return orgRequest<Snapshot>(`/snapshots/${encode(id)}`);
}

/**
 * The same snapshot, seen through the repository's accepted annotations (GP-72):
 * groups as containers, hidden nodes gone, logical edges drawn, renames applied.
 * It comes back as an ordinary Snapshot — the renderer needs to know nothing
 * about annotations to draw it.
 *
 * `granularity: "group"` collapses it further, to one node per top-level group —
 * the C4 view (GP-77). `expandGroup` keeps a single group open inside it.
 */
export function getAdaptedSnapshot(
  id: string,
  params: { granularity?: "resource" | "group"; expandGroup?: string } = {},
): Promise<Snapshot> {
  const query = new URLSearchParams();
  if (params.granularity) query.set("granularity", params.granularity);
  if (params.expandGroup) query.set("expandGroup", params.expandGroup);
  const suffix = query.size > 0 ? `?${query}` : "";
  return orgRequest<Snapshot>(`/snapshots/${encode(id)}/adapted${suffix}`);
}

/** Diff two docs snapshots (base → target); 422 for cross-repo/plan pairs (GP-40). */
export function diffSnapshots(baseId: string, targetId: string): Promise<SnapshotDiff> {
  return orgRequest<SnapshotDiff>(
    `/snapshots/${encode(baseId)}/diff/${encode(targetId)}`,
  );
}

/** Trigger documentation generation of the default branch (GP-15). */
export function generateDocs(repositoryId: string): Promise<{ id: string }> {
  return orgRequest<{ id: string }>(
    `/repositories/${encode(repositoryId)}/docs/generate`,
    { method: "POST" },
  );
}

/** Latest docs (source=hcl) snapshot including its graph. 404 if none yet. */
export function getLatestDocs(repositoryId: string): Promise<Snapshot> {
  return orgRequest<Snapshot>(`/repositories/${encode(repositoryId)}/docs/latest`);
}

export function getMe(): Promise<User> {
  return request<User>("/me");
}

// --- Organizations & invitations (GP-113..GP-117) --------------------------

/** Create an organization (SaaS mode only); the creator becomes its owner. */
export function createOrganization(
  input: CreateOrganizationInput,
): Promise<Organization> {
  return request<Organization>("/orgs", { method: "POST", body: input });
}

/** Accept an invitation by its token; returns the org the caller just joined. */
export function acceptInvitation(
  token: string,
): Promise<{ organization: { id: string; name: string; slug: string } }> {
  return request("/invitations/accept", { method: "POST", body: { token } });
}

/** Delete the active org (owner only); `confirmName` must match its name (GP-113). */
export function deleteOrganization(confirmName: string): Promise<void> {
  return orgRequest<void>("", { method: "DELETE", body: { confirmName } });
}

// --- Org members & invitations management (GP-118) --------------------------

/** The active org's member roster. */
export function listMembers(): Promise<Member[]> {
  return orgRequest<Member[]>("/members");
}

/** Change a member's role (admin+ for member↔admin; owner for ownership). */
export function changeMemberRole(userId: string, role: Role): Promise<Member> {
  return orgRequest<Member>(`/members/${encode(userId)}`, {
    method: "PATCH",
    body: { role },
  });
}

/** Remove a member from the active org (admin+). */
export function removeMember(userId: string): Promise<void> {
  return orgRequest<void>(`/members/${encode(userId)}`, { method: "DELETE" });
}

/** Pending invitations for the active org (admin+). */
export function listInvitations(): Promise<Invitation[]> {
  return orgRequest<Invitation[]>("/invitations");
}

/** Mint an invitation; the response carries the one-time token + URL (admin+). */
export function createInvitation(
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  return orgRequest<CreatedInvitation>("/invitations", {
    method: "POST",
    body: input,
  });
}

/** Revoke a pending invitation (admin+). */
export function revokeInvitation(id: string): Promise<void> {
  return orgRequest<void>(`/invitations/${encode(id)}`, { method: "DELETE" });
}

// --- Dashboard (GP-67) ------------------------------------------------------

/** Everything the home page shows — counts + recent activity — in one call. */
export function getDashboard(): Promise<Dashboard> {
  return orgRequest<Dashboard>("/dashboard");
}

// --- Annotations (GP-56..GP-59, GP-71) --------------------------------------

/**
 * A repository's annotations. `status` narrows to one bucket (the proposal inbox
 * asks for `proposed`); `snapshotId` re-resolves every anchor against that
 * snapshot, so the caller sees what has orphaned *there* rather than the verdict
 * left behind by the last generation.
 */
export function listAnnotations(
  repositoryId: string,
  params: { status?: AnnotationStatus; snapshotId?: string } = {},
): Promise<Annotation[]> {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.snapshotId) query.set("snapshotId", params.snapshotId);
  const suffix = query.size > 0 ? `?${query}` : "";
  return orgRequest<Annotation[]>(
    `/repositories/${encode(repositoryId)}/annotations${suffix}`,
  );
}

export function createAnnotation(
  repositoryId: string,
  input: CreateAnnotationInput,
): Promise<Annotation> {
  return orgRequest<Annotation>(
    `/repositories/${encode(repositoryId)}/annotations`,
    { method: "POST", body: input },
  );
}

export function updateAnnotation(
  id: string,
  input: UpdateAnnotationInput,
): Promise<Annotation> {
  return orgRequest<Annotation>(`/annotations/${encode(id)}`, {
    method: "PATCH",
    body: input,
  });
}

export function deleteAnnotation(id: string): Promise<void> {
  return orgRequest<void>(`/annotations/${encode(id)}`, { method: "DELETE" });
}

/**
 * Ask the model to propose annotations for this snapshot (GP-75). Always
 * user-triggered — generating costs money, and an estate that annotates itself
 * behind your back is not one anybody trusts.
 *
 * The proposals come back stored as `proposed`; nothing they say is live until a
 * human accepts it.
 */
export function proposeAnnotations(snapshotId: string): Promise<ProposalRun> {
  return orgRequest<ProposalRun>(
    `/snapshots/${encode(snapshotId)}/annotation-proposals`,
    { method: "POST" },
  );
}

/** Accept a proposal — the one and only way one goes live (GP-76). */
export function acceptAnnotation(id: string): Promise<Annotation> {
  return updateAnnotation(id, { status: "resolved" });
}

// --- Public share links (GP-39) --------------------------------------------

export function listShareLinks(repositoryId: string): Promise<ShareLink[]> {
  return orgRequest<ShareLink[]>(`/repositories/${encode(repositoryId)}/share-links`);
}

export function createShareLink(
  repositoryId: string,
  input: CreateShareLinkInput,
): Promise<ShareLink> {
  return orgRequest<ShareLink>(`/repositories/${encode(repositoryId)}/share-links`, {
    method: "POST",
    body: input,
  });
}

export function revokeShareLink(id: string): Promise<void> {
  return orgRequest<void>(`/share-links/${encode(id)}`, { method: "DELETE" });
}

/** Fetch a public snapshot by share token (no auth). 404 if unknown/revoked. */
export function getPublicSnapshot(token: string): Promise<PublicSnapshotView> {
  return request<PublicSnapshotView>(`/public/${encode(token)}`);
}

/** Absolute-from-origin URL of a public export image (embeddable, no auth). */
export function publicExportUrl(
  token: string,
  format: ExportFormat,
  scope: ExportScope = "full",
): string {
  const query = scope === "changes" ? "?scope=changes" : "";
  return `${apiBase()}/public/${encode(token)}/export.${format}${query}`;
}

/** The in-app URL of the read-only public share page for a token. */
export function shareUrl(token: string): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : apiRoot();
  return `${origin}/share/${encode(token)}`;
}

// --- AI layer (GP-62 / GP-64 / GP-65) --------------------------------------

/** Is the AI layer configured? When it isn't, no AI UI renders anywhere. */
export function getAiStatus(): Promise<AiStatus> {
  return request<AiStatus>("/ai/status");
}

/**
 * The prose already generated for a snapshot, or null if there is none yet.
 * "Not generated" is the normal state, not an error — so the 404 the backend
 * answers with becomes a null here rather than a thrown ApiError.
 */
export async function getAiGeneration(
  snapshotId: string,
  kind: AiKind,
): Promise<AiGeneration | null> {
  try {
    return await request<AiGeneration>(
      `/snapshots/${encode(snapshotId)}/ai/${encode(kind)}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** The endpoint `useCompletion` POSTs to in order to stream a generation. */
export function aiCompletionUrl(snapshotId: string, kind: AiKind): string {
  return `${apiBase()}/orgs/${encode(activeOrg())}/snapshots/${encode(snapshotId)}/ai/${encode(kind)}`;
}

// --- Guided tours (GP-78) ---------------------------------------------------

/**
 * The tour a snapshot already has, or null if none has been generated. Like the
 * prose, "not generated yet" is the normal state and not an error.
 *
 * There is no `kind` here on purpose: which tour you get follows from what the
 * snapshot is, so the frontend cannot ask for the wrong one.
 */
export async function getTour(snapshotId: string): Promise<TourResponse | null> {
  try {
    return await orgRequest<TourResponse>(`/snapshots/${encode(snapshotId)}/tour`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Generate a tour. Unlike the prose, this is JSON — there is nothing to stream. */
export function generateTour(
  snapshotId: string,
  opts: { regenerate?: boolean } = {},
): Promise<TourResponse> {
  return orgRequest<TourResponse>(`/snapshots/${encode(snapshotId)}/tour`, {
    method: "POST",
    body: JSON.stringify({ regenerate: opts.regenerate === true }),
  });
}

// --- Playground (GP-123..GP-126) --------------------------------------------
// User-scoped, org-free: parse is ephemeral and a draft belongs to its author
// alone, so these use the global `request`, never `orgRequest`.

/** Parse files into an ephemeral snapshot — nothing is persisted. The server
 *  parses only the subset matching `iacType` and ignores the rest. */
export function parsePlayground(
  files: PlaygroundFile[],
  iacType: IacType = "terraform",
): Promise<PlaygroundSnapshot> {
  return request<PlaygroundSnapshot>("/playground/parse", {
    method: "POST",
    body: { files, iacType },
  });
}

/** GP-142: parse the studio's generated files into a snapshot + lint. */
export function parseStudioFiles(
  files: StudioFile[],
): Promise<StudioParseResult> {
  return request<StudioParseResult>("/ai-studio/parse", {
    method: "POST",
    body: { files },
  });
}

export function listPlaygroundDrafts(): Promise<PlaygroundDraftSummary[]> {
  return request<PlaygroundDraftSummary[]>("/playground/drafts");
}

export function getPlaygroundDraft(id: string): Promise<PlaygroundDraft> {
  return request<PlaygroundDraft>(`/playground/drafts/${encode(id)}`);
}

export function createPlaygroundDraft(
  input: CreatePlaygroundDraftInput,
): Promise<PlaygroundDraft> {
  return request<PlaygroundDraft>("/playground/drafts", {
    method: "POST",
    body: input,
  });
}

export function updatePlaygroundDraft(
  id: string,
  input: UpdatePlaygroundDraftInput,
): Promise<PlaygroundDraft> {
  return request<PlaygroundDraft>(`/playground/drafts/${encode(id)}`, {
    method: "PUT",
    body: input,
  });
}

export function deletePlaygroundDraft(id: string): Promise<void> {
  return request<void>(`/playground/drafts/${encode(id)}`, {
    method: "DELETE",
  });
}

/**
 * The `fetch` the AI SDK's streaming hooks must use. They own the request, so
 * they bypass `request()` above — this keeps them on the same rails anyway:
 * the bearer token goes on, a 401 still triggers the logout handler, and a
 * non-2xx becomes an ApiError with the server's own message instead of the
 * hook's generic "Failed to fetch".
 */
export const aiFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  const token = tokenProvider();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(input, { ...init, headers });

  if (response.status === 401) unauthorizedHandler();
  if (!response.ok) {
    throw await apiErrorFrom(response);
  }
  return response;
};
