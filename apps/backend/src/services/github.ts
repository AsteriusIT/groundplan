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

export interface GitHubClient {
  listIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    token: string,
  ): Promise<GitHubComment[]>;
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
  const cleaned = url.replace(/\.git$/, "").replace(/\/+$/, "");
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
};
