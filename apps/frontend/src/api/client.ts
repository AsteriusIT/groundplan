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
  Dashboard,
  IngestionEvent,
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
  TourResponse,
  UpdateAnnotationInput,
  UpdateProjectInput,
  UpdateRepositoryInput,
  User,
  VerifyResult,
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

/** Thrown for any non-2xx response; carries the HTTP status and server message. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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
    throw new ApiError(response.status, await extractErrorMessage(response));
  }

  // 204 No Content (e.g. DELETE) carries no body.
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const data: unknown = await response.json();
    if (
      data &&
      typeof data === "object" &&
      "message" in data &&
      typeof (data as { message: unknown }).message === "string"
    ) {
      return (data as { message: string }).message;
    }
  } catch {
    // Non-JSON body — fall back to the status text.
  }
  return response.statusText || `Request failed with status ${response.status}`;
}

const encode = encodeURIComponent;

export type ExportFormat = "svg" | "png";
export type ExportScope = "full" | "changes";

/**
 * Fetch a rendered snapshot export (GP-37) as a Blob. The export endpoints sit
 * behind bearer auth, so this goes through the same token-injecting path as the
 * JSON client rather than a bare <img>/<a> (which would omit the token).
 */
export async function getSnapshotExport(
  id: string,
  format: ExportFormat,
  scope: ExportScope = "full",
): Promise<Blob> {
  const headers: Record<string, string> = {};
  const token = tokenProvider();
  if (token) headers.Authorization = `Bearer ${token}`;
  const query = scope === "changes" ? "?scope=changes" : "";
  const response = await fetch(
    `${apiBase()}/snapshots/${encode(id)}/export.${format}${query}`,
    { headers },
  );
  if (response.status === 401) unauthorizedHandler();
  if (!response.ok) {
    throw new ApiError(response.status, await extractErrorMessage(response));
  }
  return response.blob();
}

export function listProjects(): Promise<Project[]> {
  return request<Project[]>("/projects");
}

export function createProject(input: CreateProjectInput): Promise<Project> {
  return request<Project>("/projects", { method: "POST", body: input });
}

export function getProject(id: string): Promise<Project> {
  return request<Project>(`/projects/${encode(id)}`);
}

/** Update a project's name and/or its long-form context (GP-60). */
export function updateProject(
  id: string,
  input: UpdateProjectInput,
): Promise<Project> {
  return request<Project>(`/projects/${encode(id)}`, {
    method: "PATCH",
    body: input,
  });
}

export function deleteProject(id: string): Promise<void> {
  return request<void>(`/projects/${encode(id)}`, { method: "DELETE" });
}

export function listRepositories(projectId: string): Promise<Repository[]> {
  return request<Repository[]>(`/projects/${encode(projectId)}/repositories`);
}

/** Freshness signal for every repo in a project — one call for the whole list. */
export function listRepositoryActivity(
  projectId: string,
): Promise<RepositoryActivity[]> {
  return request<RepositoryActivity[]>(
    `/projects/${encode(projectId)}/repositories/activity`,
  );
}

export function createRepository(
  projectId: string,
  input: CreateRepositoryInput,
): Promise<CreatedRepository> {
  return request<CreatedRepository>(
    `/projects/${encode(projectId)}/repositories`,
    { method: "POST", body: input },
  );
}

export function getRepository(id: string): Promise<Repository> {
  return request<Repository>(`/repositories/${encode(id)}`);
}

export function updateRepository(
  id: string,
  input: UpdateRepositoryInput,
): Promise<Repository> {
  return request<Repository>(`/repositories/${encode(id)}`, {
    method: "PATCH",
    body: input,
  });
}

export function verifyRepository(id: string): Promise<VerifyResult> {
  return request<VerifyResult>(`/repositories/${encode(id)}/verify`, {
    method: "POST",
  });
}

export function deleteRepository(id: string): Promise<void> {
  return request<void>(`/repositories/${encode(id)}`, { method: "DELETE" });
}

/**
 * Rotate the repository's webhook token. The response carries the fresh token,
 * shown once — the old one stops working the moment this resolves.
 */
export function regenerateWebhookToken(id: string): Promise<CreatedRepository> {
  return request<CreatedRepository>(`/repositories/${encode(id)}/webhook-token`, {
    method: "POST",
  });
}

// --- Kubernetes clusters (GP-95) --------------------------------------------

/** Every attached cluster. A cluster is nobody's child — there is nothing to scope by. */
export function listClusters(): Promise<Cluster[]> {
  return request<Cluster[]>("/clusters");
}

/**
 * Attach a cluster. The kubeconfig goes up once and never comes back — the
 * response masks it, which is why `Cluster.kubeconfig` is typed as the mask.
 */
export function createCluster(input: CreateClusterInput): Promise<Cluster> {
  return request<Cluster>("/clusters", { method: "POST", body: input });
}

export function updateCluster(
  id: string,
  input: UpdateClusterInput,
): Promise<Cluster> {
  return request<Cluster>(`/clusters/${encode(id)}`, {
    method: "PATCH",
    body: input,
  });
}

export function verifyCluster(id: string): Promise<ClusterVerifyResult> {
  return request<ClusterVerifyResult>(`/clusters/${encode(id)}/verify`, {
    method: "POST",
  });
}

export function deleteCluster(id: string): Promise<void> {
  return request<void>(`/clusters/${encode(id)}`, { method: "DELETE" });
}

export function getCluster(id: string): Promise<Cluster> {
  return request<Cluster>(`/clusters/${encode(id)}`);
}

// --- Kubernetes namespaces & snapshots (GP-97) ------------------------------

/** The cluster's namespaces, read live. 502 when the cluster is unreachable. */
export function listClusterNamespaces(clusterId: string): Promise<string[]> {
  return request<{ namespaces: string[] }>(
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
  return request<Snapshot>(
    `/clusters/${encode(clusterId)}/namespaces/${encode(namespace)}/snapshots`,
    { method: "POST", body: {} },
  );
}

/** This namespace's snapshots, newest first (GP-26's shape, for a cluster). */
export function listNamespaceSnapshots(
  clusterId: string,
  namespace: string,
): Promise<SnapshotSummary[]> {
  return request<SnapshotSummary[]>(
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
  return request<PullSummary[]>(`/repositories/${encode(repositoryId)}/pulls`);
}

/**
 * The last CI webhooks Groundplan received for a repository (GP-5), newest first.
 * The setup page (GP-111) reads the most recent to show whether CI has reached us.
 */
export function listEvents(repositoryId: string): Promise<IngestionEvent[]> {
  return request<IngestionEvent[]>(`/repositories/${encode(repositoryId)}/events`);
}

export function getPull(
  repositoryId: string,
  number: number,
): Promise<PullDetail> {
  return request<PullDetail>(
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
  return request<SnapshotSummary[]>(
    `/repositories/${encode(repositoryId)}/snapshots${query ? `?${query}` : ""}`,
  );
}

export function getSnapshot(id: string): Promise<Snapshot> {
  return request<Snapshot>(`/snapshots/${encode(id)}`);
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
  return request<Snapshot>(`/snapshots/${encode(id)}/adapted${suffix}`);
}

/** Diff two docs snapshots (base → target); 422 for cross-repo/plan pairs (GP-40). */
export function diffSnapshots(baseId: string, targetId: string): Promise<SnapshotDiff> {
  return request<SnapshotDiff>(
    `/snapshots/${encode(baseId)}/diff/${encode(targetId)}`,
  );
}

/** Trigger documentation generation of the default branch (GP-15). */
export function generateDocs(repositoryId: string): Promise<{ id: string }> {
  return request<{ id: string }>(
    `/repositories/${encode(repositoryId)}/docs/generate`,
    { method: "POST" },
  );
}

/** Latest docs (source=hcl) snapshot including its graph. 404 if none yet. */
export function getLatestDocs(repositoryId: string): Promise<Snapshot> {
  return request<Snapshot>(`/repositories/${encode(repositoryId)}/docs/latest`);
}

export function getMe(): Promise<User> {
  return request<User>("/me");
}

// --- Dashboard (GP-67) ------------------------------------------------------

/** Everything the home page shows — counts + recent activity — in one call. */
export function getDashboard(): Promise<Dashboard> {
  return request<Dashboard>("/dashboard");
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
  return request<Annotation[]>(
    `/repositories/${encode(repositoryId)}/annotations${suffix}`,
  );
}

export function createAnnotation(
  repositoryId: string,
  input: CreateAnnotationInput,
): Promise<Annotation> {
  return request<Annotation>(
    `/repositories/${encode(repositoryId)}/annotations`,
    { method: "POST", body: input },
  );
}

export function updateAnnotation(
  id: string,
  input: UpdateAnnotationInput,
): Promise<Annotation> {
  return request<Annotation>(`/annotations/${encode(id)}`, {
    method: "PATCH",
    body: input,
  });
}

export function deleteAnnotation(id: string): Promise<void> {
  return request<void>(`/annotations/${encode(id)}`, { method: "DELETE" });
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
  return request<ProposalRun>(
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
  return request<ShareLink[]>(`/repositories/${encode(repositoryId)}/share-links`);
}

export function createShareLink(
  repositoryId: string,
  input: CreateShareLinkInput,
): Promise<ShareLink> {
  return request<ShareLink>(`/repositories/${encode(repositoryId)}/share-links`, {
    method: "POST",
    body: input,
  });
}

export function revokeShareLink(id: string): Promise<void> {
  return request<void>(`/share-links/${encode(id)}`, { method: "DELETE" });
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
  return `${apiBase()}/snapshots/${encode(snapshotId)}/ai/${encode(kind)}`;
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
    return await request<TourResponse>(`/snapshots/${encode(snapshotId)}/tour`);
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
  return request<TourResponse>(`/snapshots/${encode(snapshotId)}/tour`, {
    method: "POST",
    body: JSON.stringify({ regenerate: opts.regenerate === true }),
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
    throw new ApiError(response.status, await extractErrorMessage(response));
  }
  return response;
};
