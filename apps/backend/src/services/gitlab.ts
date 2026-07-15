/**
 * Minimal GitLab REST client for merge-request notes (GP-53). Mirrors the
 * GitHub client's shape: only the three calls the comment flow needs
 * (list/create/update MR notes) over global fetch with the repository's stored
 * PAT. Injectable (see buildApp) so tests never touch the network. Works for
 * gitlab.com and self-hosted instances — the API base is derived from the repo
 * host, so there is no separate configuration.
 *
 * Note: posting notes needs a PAT with the `api` scope (broader than the
 * `read_repository` scope used to clone); failures surface that clearly.
 */
export interface GitLabNote {
  id: number;
  body: string;
}

export interface GitLabClient {
  listMergeRequestNotes(
    apiBase: string,
    projectPath: string,
    mrIid: number,
    token: string,
  ): Promise<GitLabNote[]>;
  createMergeRequestNote(
    apiBase: string,
    projectPath: string,
    mrIid: number,
    body: string,
    token: string,
  ): Promise<GitLabNote>;
  updateMergeRequestNote(
    apiBase: string,
    projectPath: string,
    mrIid: number,
    noteId: number,
    body: string,
    token: string,
  ): Promise<GitLabNote>;
}

/** Thrown for any non-2xx GitLab response; message is safe to store/show. */
export class GitLabApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitLabApiError";
    this.status = status;
  }
}

/**
 * Derive the v4 API base URL and (unencoded) project path from a GitLab repo
 * URL. The API lives at `{origin}/api/v4` for both gitlab.com and self-hosted
 * instances. Returns null for a non-URL or a path without at least a group/repo.
 */
export function parseGitLabRepo(
  url: string,
): { apiBase: string; projectPath: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  // The trailing-slash trim uses an atomic group (lookahead + backreference)
  // instead of `\/+$` so it cannot cause non-linear backtracking (S8786).
  const projectPath = u.pathname.replace(/\.git$/, "").replace(/^\/+|(?=(\/+))\1$/g, "");
  if (!projectPath.includes("/")) return null; // need at least group/repo
  return { apiBase: `${u.origin}/api/v4`, projectPath };
}

const enc = encodeURIComponent;

function notesUrl(apiBase: string, projectPath: string, mrIid: number): string {
  return `${apiBase}/projects/${enc(projectPath)}/merge_requests/${mrIid}/notes`;
}

function headers(token: string): Record<string, string> {
  return {
    "PRIVATE-TOKEN": token,
    "Content-Type": "application/json",
    "User-Agent": "groundplan",
  };
}

async function toError(res: Response): Promise<GitLabApiError> {
  let detail = res.statusText;
  try {
    const data = (await res.json()) as { message?: unknown; error?: unknown };
    const m = data?.message ?? data?.error;
    if (typeof m === "string") detail = m;
  } catch {
    // non-JSON body — keep the status text
  }
  const hint =
    res.status === 401 || res.status === 403
      ? " (check the PAT has the 'api' scope and access to this project)"
      : "";
  return new GitLabApiError(res.status, `GitLab API ${res.status}: ${detail}${hint}`);
}

/** The real GitLab client. */
export const realGitLabClient: GitLabClient = {
  async listMergeRequestNotes(apiBase, projectPath, mrIid, token) {
    const res = await fetch(`${notesUrl(apiBase, projectPath, mrIid)}?per_page=100`, {
      headers: headers(token),
    });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as GitLabNote[];
  },

  async createMergeRequestNote(apiBase, projectPath, mrIid, body, token) {
    const res = await fetch(notesUrl(apiBase, projectPath, mrIid), {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as GitLabNote;
  },

  async updateMergeRequestNote(apiBase, projectPath, mrIid, noteId, body, token) {
    const res = await fetch(`${notesUrl(apiBase, projectPath, mrIid)}/${noteId}`, {
      method: "PUT",
      headers: headers(token),
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as GitLabNote;
  },
};
