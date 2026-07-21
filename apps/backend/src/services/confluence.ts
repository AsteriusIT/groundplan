/**
 * Confluence REST client (GP-179) — the smallest surface the export epic needs.
 *
 * REST v1 (`/rest/api`) on purpose: it is the API surface Cloud and Data Center
 * share, so one client serves both editions. Auth is a *header strategy*, not an
 * adapter hierarchy: Cloud = Basic `email:token`, DC = Bearer PAT.
 *
 * The verify call mirrors the repository (`git ls-remote`, GP-11) and cluster
 * (`/version`, GP-95) checks: the cheapest request that proves the instance is
 * reachable, the credential is accepted and the space exists — and failures map
 * to a small closed set of kinds. Nothing here ever logs or returns the
 * credential; error bodies are never surfaced (they can echo the request).
 */

export type ConfluenceAuthType = "cloud_token" | "dc_pat";

export type ConfluenceTarget = {
  /** Instance base URL — for Cloud the wiki origin (`https://x.atlassian.net/wiki`). */
  baseUrl: string;
  authType: ConfluenceAuthType;
  /** Basic-auth username for a Cloud token; null for a DC PAT. */
  email: string | null;
  /** The plaintext API token / PAT. Never logged. */
  credential: string;
};

/** Why a Confluence call failed. The caller renders its own message from these. */
export type ConfluenceErrorKind = "auth_failed" | "space_not_found" | "network";

export type ConfluenceVerifyResult =
  | { ok: true; /** The space's display name, when the instance reported one. */ spaceName: string | null }
  | { ok: false; error: ConfluenceErrorKind };

/** Page-level calls can additionally find their page gone (GP-180 recreates). */
export type ConfluencePageErrorKind = ConfluenceErrorKind | "page_not_found";

export type ConfluencePage = {
  id: string;
  version: number;
  /** The page's web URL, when the API said (`_links`); else a derived one. */
  url: string | null;
};

export type ConfluencePageResult =
  | { ok: true; page: ConfluencePage }
  | { ok: false; error: ConfluencePageErrorKind };

export type ConfluenceAttachmentResult =
  | { ok: true }
  | { ok: false; error: ConfluencePageErrorKind };

export interface ConfluenceClient {
  /** `GET /rest/api/space?limit=1` — reachability + credential, no space (GP-183):
   * an org Integration authenticates to the *instance*; which space a repo
   * publishes to is a repo-level target checked at publish. A 401/403 is a bad
   * credential; an unreachable host (or a 404 from the wrong base URL) is a bad
   * URL — the two the verify endpoint must distinguish. */
  verifyCredential(target: ConfluenceTarget): Promise<ConfluenceVerifyResult>;
  /** `GET /rest/api/space/{key}` — reachability, credential and space in one call. */
  verifySpace(
    target: ConfluenceTarget,
    spaceKey: string,
  ): Promise<ConfluenceVerifyResult>;
  /** `GET /rest/api/content/{id}` — a 404 means the page is gone. */
  getPage(target: ConfluenceTarget, pageId: string): Promise<ConfluencePageResult>;
  /** `POST /rest/api/content` — a 404 here means the *space* does not exist. */
  createPage(
    target: ConfluenceTarget,
    input: { spaceKey: string; title: string; storage: string },
  ): Promise<ConfluencePageResult>;
  /** `PUT /rest/api/content/{id}` with the next version number. */
  updatePage(
    target: ConfluenceTarget,
    input: { pageId: string; title: string; storage: string; version: number },
  ): Promise<ConfluencePageResult>;
  /** `PUT /rest/api/content/{id}/child/attachment` — creates or updates the
   * attachment *by filename*, which is exactly the no-duplicates behaviour. */
  uploadAttachment(
    target: ConfluenceTarget,
    input: { pageId: string; filename: string; contentType: string; data: Buffer },
  ): Promise<ConfluenceAttachmentResult>;
}

/** The Authorization header for a target — the one place the strategy lives. */
export function confluenceAuthHeader(target: ConfluenceTarget): string {
  if (target.authType === "cloud_token") {
    const basic = Buffer.from(`${target.email ?? ""}:${target.credential}`);
    return `Basic ${basic.toString("base64")}`;
  }
  return `Bearer ${target.credential}`;
}

/** A URL without its trailing slashes — the canonical stored/joined form. */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

/** `{base}/rest/api/{path}` with a normalized join. */
export function confluenceApiUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlashes(baseUrl)}/rest/api/${path}`;
}

/** Map an HTTP status onto a kind — the status is the only thing we read. */
function classifyStatus(status: number): ConfluenceErrorKind {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "space_not_found";
  // 5xx and the rest: the instance answered but is not usable — for the caller
  // that is indistinguishable from "could not reach it".
  return "network";
}

/**
 * One REST call: fetch, map 401/403 → auth_failed, 404 → `notFoundKind`
 * (whose meaning depends on what the endpoint addresses), anything else that
 * is not 2xx → network. A thrown fetch (DNS, refused, TLS) is network too.
 */
async function apiCall<K extends ConfluenceErrorKind | ConfluencePageErrorKind>(
  target: ConfluenceTarget,
  path: string,
  init: RequestInit,
  notFoundKind: K,
): Promise<{ ok: true; body: unknown } | { ok: false; error: K | ConfluenceErrorKind }> {
  let res: Response;
  try {
    res = await fetch(confluenceApiUrl(target.baseUrl, path), {
      ...init,
      headers: {
        authorization: confluenceAuthHeader(target),
        accept: "application/json",
        ...init.headers,
      },
    });
  } catch {
    return { ok: false, error: "network" };
  }
  if (!res.ok) {
    const kind = classifyStatus(res.status);
    return { ok: false, error: kind === "space_not_found" ? notFoundKind : kind };
  }
  return { ok: true, body: await res.json().catch(() => null) };
}

/** The page shape out of a content response; the URL prefers `_links`. */
function parsePage(baseUrl: string, body: unknown): ConfluencePage {
  const raw = body as {
    id?: unknown;
    version?: { number?: unknown };
    _links?: { base?: unknown; webui?: unknown };
  } | null;
  const id =
    typeof raw?.id === "string" || typeof raw?.id === "number"
      ? String(raw.id)
      : "";
  const version =
    typeof raw?.version?.number === "number" ? raw.version.number : 1;
  const base = raw?._links?.base;
  const webui = raw?._links?.webui;
  let url: string | null = null;
  if (typeof base === "string" && typeof webui === "string") {
    url = `${base}${webui}`;
  } else if (id) {
    url = `${trimTrailingSlashes(baseUrl)}/pages/viewpage.action?pageId=${id}`;
  }
  return { id, version, url };
}

function pageBody(title: string, storage: string, extra: Record<string, unknown>) {
  return JSON.stringify({
    type: "page",
    title,
    body: { storage: { value: storage, representation: "storage" } },
    ...extra,
  });
}

const JSON_HEADERS = { "content-type": "application/json" };

export const realConfluenceClient: ConfluenceClient = {
  async verifyCredential(target) {
    // `space?limit=1` is the cheapest authenticated read common to Cloud and
    // DC: a 2xx (even an empty list) proves the credential is accepted and the
    // instance is reachable. A 404 here means the base URL is not a Confluence
    // API root → `network` (bad URL), not `space_not_found`.
    const res = await apiCall(target, "space?limit=1", {}, "network");
    if (!res.ok) return res;
    return { ok: true, spaceName: null };
  },

  async verifySpace(target, spaceKey) {
    const res = await apiCall(
      target,
      `space/${encodeURIComponent(spaceKey)}`,
      {},
      "space_not_found",
    );
    if (!res.ok) return res;
    const body = res.body as { name?: unknown } | null;
    return {
      ok: true,
      spaceName: typeof body?.name === "string" ? body.name : null,
    };
  },

  async getPage(target, pageId) {
    const res = await apiCall(
      target,
      `content/${encodeURIComponent(pageId)}?expand=version`,
      {},
      "page_not_found",
    );
    if (!res.ok) return res;
    return { ok: true, page: parsePage(target.baseUrl, res.body) };
  },

  async createPage(target, input) {
    const res = await apiCall(
      target,
      "content",
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: pageBody(input.title, input.storage, {
          space: { key: input.spaceKey },
        }),
      },
      "space_not_found",
    );
    if (!res.ok) return res;
    return { ok: true, page: parsePage(target.baseUrl, res.body) };
  },

  async updatePage(target, input) {
    const res = await apiCall(
      target,
      `content/${encodeURIComponent(input.pageId)}`,
      {
        method: "PUT",
        headers: JSON_HEADERS,
        body: pageBody(input.title, input.storage, {
          id: input.pageId,
          version: { number: input.version },
        }),
      },
      "page_not_found",
    );
    if (!res.ok) return res;
    return { ok: true, page: parsePage(target.baseUrl, res.body) };
  },

  async uploadAttachment(target, input) {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(input.data)], { type: input.contentType }),
      input.filename,
    );
    form.append("minorEdit", "true");
    const res = await apiCall(
      target,
      `content/${encodeURIComponent(input.pageId)}/child/attachment`,
      {
        method: "PUT",
        // No content-type here: fetch sets the multipart boundary itself.
        headers: { "X-Atlassian-Token": "nocheck" },
        body: form,
      },
      "page_not_found",
    );
    if (!res.ok) return res;
    return { ok: true };
  },
};
