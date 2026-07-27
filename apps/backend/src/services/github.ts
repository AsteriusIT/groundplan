/**
 * Minimal GitHub REST client for PR comments (GP-38). Only the three calls the
 * comment flow needs — list/create/update issue comments — over global fetch
 * with the repository's stored PAT. Injectable (see buildApp) so tests never
 * touch the network. We never log the token; failures carry a clear message so
 * a missing `repo` scope surfaces in repo settings.
 */
export interface GitHubComment {
  id: number;
  body: string;
}

/** A repository tree as `GET /repos/{owner}/{repo}/git/trees/{ref}` reports it. */
export type GitHubTree = {
  tree: { path: string; type: string }[];
  /**
   * GitHub's own "there was more than I would send" flag. Carried through to
   * detection, which then refuses to be confident (GP-228).
   */
  truncated: boolean;
};

export interface GitHubClient {
  listIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    token: string,
  ): Promise<GitHubComment[]>;
  /**
   * The whole tree of a ref in one recursive call (GP-228) — the alternative to
   * cloning a repository just to see whether it holds `.tf` files.
   */
  getTree(
    owner: string,
    repo: string,
    ref: string,
    token: string,
  ): Promise<GitHubTree>;
  /**
   * The first bytes of one file, or null when it is absent. Used only to read
   * the head keys of a candidate YAML — never to parse a file.
   */
  getFileHead(
    owner: string,
    repo: string,
    ref: string,
    path: string,
    token: string,
  ): Promise<string | null>;
  createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
    token: string,
  ): Promise<GitHubComment>;
  updateIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
    token: string,
  ): Promise<GitHubComment>;
}

/** Thrown for any non-2xx GitHub response; message is safe to store/show. */
export class GitHubApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

const API = "https://api.github.com";

/** Parse `owner` / `repo` from a GitHub repository URL. */
export function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const cleaned = url.replace(/\.git$/, "").replace(/(?=(\/+))\1$/, "");
  const match = /github\.com[/:]([^/]+)\/([^/]+)$/.exec(cleaned);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "groundplan",
  };
}

async function toError(res: Response): Promise<GitHubApiError> {
  let detail = res.statusText;
  try {
    const data = (await res.json()) as { message?: string };
    if (data?.message) detail = data.message;
  } catch {
    // non-JSON body — keep the status text
  }
  const hint =
    res.status === 403 || res.status === 404
      ? " (check the PAT has the 'repo' scope and access to this repository)"
      : "";
  return new GitHubApiError(res.status, `GitHub API ${res.status}: ${detail}${hint}`);
}

/** The real GitHub client. */
export const realGitHubClient: GitHubClient = {
  async listIssueComments(owner, repo, issueNumber, token) {
    // First page (up to 100) is plenty to find our single marked comment.
    const res = await fetch(
      `${API}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
      { headers: headers(token) },
    );
    if (!res.ok) throw await toError(res);
    return (await res.json()) as GitHubComment[];
  },

  async createIssueComment(owner, repo, issueNumber, body, token) {
    const res = await fetch(
      `${API}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { method: "POST", headers: headers(token), body: JSON.stringify({ body }) },
    );
    if (!res.ok) throw await toError(res);
    return (await res.json()) as GitHubComment;
  },

  async updateIssueComment(owner, repo, commentId, body, token) {
    const res = await fetch(
      `${API}/repos/${owner}/${repo}/issues/comments/${commentId}`,
      { method: "PATCH", headers: headers(token), body: JSON.stringify({ body }) },
    );
    if (!res.ok) throw await toError(res);
    return (await res.json()) as GitHubComment;
  },

  async getTree(owner, repo, ref, token) {
    // `recursive=1`: one call for the whole tree. GitHub caps the response and
    // says so with `truncated`, which we pass on rather than hide.
    const res = await fetch(
      `${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      { headers: headers(token) },
    );
    if (!res.ok) throw await toError(res);
    const body = (await res.json()) as {
      tree?: { path?: string; type?: string }[];
      truncated?: boolean;
    };
    return {
      tree: (body.tree ?? [])
        .filter((entry): entry is { path: string; type: string } =>
          typeof entry.path === "string" && typeof entry.type === "string",
        )
        .map((entry) => ({ path: entry.path, type: entry.type })),
      truncated: body.truncated === true,
    };
  },

  async getFileHead(owner, repo, ref, path, token) {
    const res = await fetch(
      `${API}/repos/${owner}/${repo}/contents/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?ref=${encodeURIComponent(ref)}`,
      { headers: { ...headers(token), Accept: "application/vnd.github.raw" } },
    );
    // A file we cannot read is a signal we do not have, not a failure: the
    // detection simply stays uncertain, which is a state it already models.
    if (res.status === 404) return null;
    if (!res.ok) throw await toError(res);
    const text = await res.text();
    return text.slice(0, FILE_HEAD_BYTES);
  },
};

/**
 * How much of a candidate YAML we look at. `apiVersion` and `kind` sit in the
 * first lines of a manifest by convention and by the shape of the format; this
 * is a peek, not a parse (GP-228 explicitly excludes parsing file content).
 */
const FILE_HEAD_BYTES = 2048;
