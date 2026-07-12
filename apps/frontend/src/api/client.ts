/**
 * The single place where HTTP happens. A thin, typed wrapper over `fetch`:
 * base URL from runtime config, JSON handling, bearer-token injection, and a
 * single ApiError for non-2xx responses.
 */
import { getConfig } from "@/config";

import type {
  CreatedRepository,
  CreateProjectInput,
  CreateRepositoryInput,
  CreateShareLinkInput,
  Project,
  PublicSnapshotView,
  PullDetail,
  PullSummary,
  Repository,
  ShareLink,
  Snapshot,
  SnapshotDiff,
  SnapshotSummary,
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

export function deleteProject(id: string): Promise<void> {
  return request<void>(`/projects/${encode(id)}`, { method: "DELETE" });
}

export function listRepositories(projectId: string): Promise<Repository[]> {
  return request<Repository[]>(`/projects/${encode(projectId)}/repositories`);
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
 * Absolute URL CI posts plan.json to (GP-5). Uses the configured API origin, or
 * the current origin in dev — so the copy-paste snippet is always usable.
 */
export function webhookUrl(repositoryId: string): string {
  const origin =
    apiRoot() || (typeof window !== "undefined" ? window.location.origin : "");
  return `${origin}/api/v1/webhooks/ci/${repositoryId}`;
}

// --- Pull requests & graph snapshots (GP-12 / GP-14 / GP-17 / GP-18) --------

export function listPulls(repositoryId: string): Promise<PullSummary[]> {
  return request<PullSummary[]>(`/repositories/${encode(repositoryId)}/pulls`);
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
  opts: { source?: "plan" | "hcl"; prNumber?: number } = {},
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
