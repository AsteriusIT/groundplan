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

/** A project as `GET /projects` reports it. */
export type GitLabProject = {
  id: number;
  /** `group/subgroup/project` — the name a human recognises. */
  path_with_namespace: string;
  name: string;
  path: string;
  http_url_to_repo: string;
  default_branch: string | null;
  /** `private` | `internal` | `public`. */
  visibility: string;
  archived: boolean;
  last_activity_at: string | null;
  namespace?: { full_path?: string } | null;
};

/** One entry of `GET /projects/:id/repository/tree`. */
export type GitLabTreeEntry = { path: string; type: string };

export interface GitLabClient {
  listMergeRequestNotes(
    apiBase: string,
    projectPath: string,
    mrIid: number,
    token: string,
  ): Promise<GitLabNote[]>;
  /**
   * The projects this credential can reach (GP-232), one page at a time.
   * `nextPage` comes from GitLab's own `X-Next-Page` header — null on the last
   * page, which is how the caller knows to stop without guessing from a length.
   */
  listProjects(
    apiBase: string,
    token: string,
    page: number,
  ): Promise<{ projects: GitLabProject[]; nextPage: number | null }>;
  /**
   * A page of a project's file tree (GP-232). GitLab paginates this where
   * GitHub does not, so the caller stops at a bound and reports the rest as
   * truncated rather than walking a monorepo to the end.
   */
  getTree(
    apiBase: string,
    projectPath: string,
    ref: string,
    page: number,
    token: string,
  ): Promise<{ entries: GitLabTreeEntry[]; nextPage: number | null }>;
  /** The first bytes of one file, or null when it is absent/unreadable. */
  getFileHead(
    apiBase: string,
    projectPath: string,
    ref: string,
    path: string,
    token: string,
  ): Promise<string | null>;
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

  async listProjects(apiBase, token, page) {
    // `membership=true` is the whole honesty of GitLab discovery: this is the
    // set of projects the authorizing *account* belongs to, not an
    // organization's perimeter. The UI says so rather than implying otherwise.
    const res = await fetch(
      `${apiBase}/projects?membership=true&per_page=${PER_PAGE}&page=${page}&order_by=path&sort=asc`,
      { headers: bearer(token) },
    );
    if (!res.ok) throw await toError(res);
    return {
      projects: (await res.json()) as GitLabProject[],
      nextPage: nextPageOf(res),
    };
  },

  async getTree(apiBase, projectPath, ref, page, token) {
    const res = await fetch(
      `${apiBase}/projects/${enc(projectPath)}/repository/tree` +
        `?recursive=true&per_page=${PER_PAGE}&page=${page}&ref=${enc(ref)}`,
      { headers: bearer(token) },
    );
    // An empty repository has no tree at all; that is "nothing recognisable",
    // which detection already models, not a failure.
    if (res.status === 404) return { entries: [], nextPage: null };
    if (!res.ok) throw await toError(res);
    return {
      entries: (await res.json()) as GitLabTreeEntry[],
      nextPage: nextPageOf(res),
    };
  },

  async getFileHead(apiBase, projectPath, ref, path, token) {
    const res = await fetch(
      `${apiBase}/projects/${enc(projectPath)}/repository/files/${enc(path)}/raw?ref=${enc(ref)}`,
      { headers: bearer(token) },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await toError(res);
    return (await res.text()).slice(0, FILE_HEAD_BYTES);
  },
};

/** GitLab's maximum page size. */
const PER_PAGE = 100;

/** As much of a candidate YAML as `apiVersion`/`kind` could hide in (GP-228). */
const FILE_HEAD_BYTES = 2048;

/**
 * OAuth tokens authenticate with `Authorization: Bearer`; `PRIVATE-TOKEN` is
 * for personal/project/group tokens only. Bearer accepts both, so the calls
 * added for discovery use it and work for either kind of credential.
 */
function bearer(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "groundplan",
  };
}

/** GitLab's own "is there more?" header — no guessing from a page length. */
function nextPageOf(res: Response): number | null {
  const raw = res.headers.get("x-next-page");
  if (!raw) return null;
  const page = Number.parseInt(raw, 10);
  return Number.isSafeInteger(page) && page > 0 ? page : null;
}
