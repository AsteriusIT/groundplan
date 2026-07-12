/**
 * Minimal Azure DevOps REST client for pull-request comment threads (GP-54).
 * Same shape as the GitHub/GitLab clients: only the calls the comment flow
 * needs (list threads, create a thread, update a comment) over global fetch with
 * the repository's stored PAT (basic auth). Injectable (see buildApp) so tests
 * never touch the network. Works for Azure DevOps Services (dev.azure.com,
 * *.visualstudio.com) and Azure DevOps Server — the API base is derived from the
 * repo host + collection path, so there is no separate configuration.
 */
const API_VERSION = "7.1";

export interface AdoComment {
  id: number;
  content: string;
}

export interface AdoThread {
  id: number;
  comments: AdoComment[];
}

export interface AzureDevOpsClient {
  listThreads(
    apiBase: string,
    project: string,
    repo: string,
    prId: number,
    token: string,
  ): Promise<AdoThread[]>;
  createThread(
    apiBase: string,
    project: string,
    repo: string,
    prId: number,
    content: string,
    token: string,
  ): Promise<AdoThread>;
  updateComment(
    apiBase: string,
    project: string,
    repo: string,
    prId: number,
    threadId: number,
    commentId: number,
    content: string,
    token: string,
  ): Promise<AdoComment>;
}

/** Thrown for any non-2xx Azure DevOps response; message is safe to store/show. */
export class AzureDevOpsApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AzureDevOpsApiError";
    this.status = status;
  }
}

/**
 * Derive the REST API base, project and repo from an Azure DevOps clone URL.
 * The base is `{origin}[/collection…]/{org?}` — everything up to the project —
 * so `.../{project}/_apis/git/...` is appended by the client. Returns null when
 * the URL is not a `.../{project}/_git/{repo}` form.
 */
export function parseAzureDevOpsRepo(
  url: string,
): { apiBase: string; project: string; repo: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const path = u.pathname.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  const marker = "/_git/";
  const idx = path.indexOf(marker);
  if (idx === -1) return null;

  const repo = path.slice(idx + marker.length).split("/").filter(Boolean)[0];
  const leftParts = path.slice(0, idx).split("/").filter(Boolean);
  const project = leftParts[leftParts.length - 1];
  if (!repo || !project) return null;

  const basePath = leftParts.slice(0, -1).join("/");
  const apiBase = basePath ? `${u.origin}/${basePath}` : u.origin;
  return { apiBase, project, repo };
}

const enc = encodeURIComponent;

function threadsUrl(
  apiBase: string,
  project: string,
  repo: string,
  prId: number,
): string {
  return `${apiBase}/${enc(project)}/_apis/git/repositories/${enc(repo)}/pullRequests/${prId}/threads`;
}

function headers(token: string): Record<string, string> {
  // Azure DevOps PAT auth is HTTP basic with an empty username.
  const basic = Buffer.from(`:${token}`).toString("base64");
  return {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/json",
    "User-Agent": "groundplan",
  };
}

async function toError(res: Response): Promise<AzureDevOpsApiError> {
  let detail = res.statusText;
  try {
    const data = (await res.json()) as { message?: unknown };
    if (typeof data?.message === "string") detail = data.message;
  } catch {
    // non-JSON body — keep the status text
  }
  const hint =
    res.status === 401 || res.status === 403
      ? " (check the PAT has Code (read & write) access to post PR comments)"
      : "";
  return new AzureDevOpsApiError(
    res.status,
    `Azure DevOps API ${res.status}: ${detail}${hint}`,
  );
}

/** The real Azure DevOps client. */
export const realAzureDevOpsClient: AzureDevOpsClient = {
  async listThreads(apiBase, project, repo, prId, token) {
    const res = await fetch(
      `${threadsUrl(apiBase, project, repo, prId)}?api-version=${API_VERSION}`,
      { headers: headers(token) },
    );
    if (!res.ok) throw await toError(res);
    const data = (await res.json()) as { value?: AdoThread[] };
    return data.value ?? [];
  },

  async createThread(apiBase, project, repo, prId, content, token) {
    const res = await fetch(
      `${threadsUrl(apiBase, project, repo, prId)}?api-version=${API_VERSION}`,
      {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({
          comments: [{ parentCommentId: 0, content, commentType: "text" }],
          status: "active",
        }),
      },
    );
    if (!res.ok) throw await toError(res);
    return (await res.json()) as AdoThread;
  },

  async updateComment(apiBase, project, repo, prId, threadId, commentId, content, token) {
    const res = await fetch(
      `${threadsUrl(apiBase, project, repo, prId)}/${threadId}/comments/${commentId}?api-version=${API_VERSION}`,
      { method: "PATCH", headers: headers(token), body: JSON.stringify({ content }) },
    );
    if (!res.ok) throw await toError(res);
    return (await res.json()) as AdoComment;
  },
};
