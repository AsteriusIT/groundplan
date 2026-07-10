/**
 * The single place where HTTP happens. A thin, typed wrapper over `fetch`:
 * base URL from env, JSON handling, bearer-token injection, and a single
 * ApiError for non-2xx responses.
 */
import type {
  CreatedRepository,
  CreateProjectInput,
  CreateRepositoryInput,
  Project,
  Repository,
  User,
} from "./types";

const API_BASE = `${import.meta.env.VITE_API_URL ?? ""}/api/v1`;

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

  const response = await fetch(`${API_BASE}${path}`, {
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

export function getMe(): Promise<User> {
  return request<User>("/me");
}
