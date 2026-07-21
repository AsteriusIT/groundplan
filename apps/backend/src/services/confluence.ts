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

export interface ConfluenceClient {
  /** `GET /rest/api/space/{key}` — reachability, credential and space in one call. */
  verifySpace(
    target: ConfluenceTarget,
    spaceKey: string,
  ): Promise<ConfluenceVerifyResult>;
}

/** The Authorization header for a target — the one place the strategy lives. */
export function confluenceAuthHeader(target: ConfluenceTarget): string {
  if (target.authType === "cloud_token") {
    const basic = Buffer.from(`${target.email ?? ""}:${target.credential}`);
    return `Basic ${basic.toString("base64")}`;
  }
  return `Bearer ${target.credential}`;
}

/** `{base}/rest/api/{path}` with a normalized join. */
export function confluenceApiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/rest/api/${path}`;
}

/** Map an HTTP status onto a kind — the status is the only thing we read. */
function classifyStatus(status: number): ConfluenceErrorKind {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "space_not_found";
  // 5xx and the rest: the instance answered but is not usable — for the caller
  // that is indistinguishable from "could not reach it".
  return "network";
}

export const realConfluenceClient: ConfluenceClient = {
  async verifySpace(target, spaceKey) {
    let res: Response;
    try {
      res = await fetch(
        confluenceApiUrl(target.baseUrl, `space/${encodeURIComponent(spaceKey)}`),
        {
          headers: {
            authorization: confluenceAuthHeader(target),
            accept: "application/json",
          },
        },
      );
    } catch {
      return { ok: false, error: "network" };
    }
    if (!res.ok) return { ok: false, error: classifyStatus(res.status) };
    const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
    return {
      ok: true,
      spaceName: typeof body?.name === "string" ? body.name : null,
    };
  },
};
