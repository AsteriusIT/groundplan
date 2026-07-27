/**
 * Repository discovery (GP-227) — turning "this org has an installation" into
 * "here are the repositories you can import".
 *
 * The port (`RepoDiscoverer`) is paged, because that is how every provider's API
 * works. This service drives it **to exhaustion** and caches the whole set for a
 * minute, which buys three things the paged port alone cannot:
 *
 *  - search is answered over the *entire* scope, not the page in hand, so typing
 *    a name finds a repository that lives on page 4;
 *  - the cursor the caller receives is ours — an offset into a list we hold —
 *    so no provider URL ever round-trips through the browser;
 *  - a user scrolling and searching during onboarding does not replay the whole
 *    pagination on every keystroke.
 *
 * The cache is per (org, connection) and in memory. A minute is short enough
 * that a repository added on GitHub shows up while the user is still looking for
 * it, and an import invalidates it immediately — the one change we cause
 * ourselves is the one we must not make people wait for.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";

import {
  integrationCredentials,
  projects,
  repositories,
  type IntegrationCredentialRow,
} from "../db/schema.js";
import { strategyForCredential } from "../integrations/credentials.js";
import {
  DiscoveryError,
  type DiscoveredRepo,
  type ProviderId,
  type RepoDiscoverer,
} from "../integrations/types.js";
import { repoUrlKey } from "../lib/repo-url.js";

/** How long a discovered scope stays fresh. */
const CACHE_TTL_MS = 60_000;

/**
 * A hard stop on how far we will page one connection. 100 pages of 100 is far
 * past any real installation; it exists so an adapter that never stops
 * advancing its cursor cannot spin this loop forever.
 */
const MAX_PAGES = 100;

/** Default and maximum page size we hand back to the browser. */
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/** How this repository is already attached in this org (GP-227). */
export type RepoAttachment = {
  repoId: string;
  projectId: string;
  /** `terraform` | `kubernetes` — the immutable kind chosen at import. */
  kind: string;
  path: string;
};

/**
 * A discovered repository plus our own knowledge of it. An empty `attachments`
 * means "never imported"; a non-empty one does **not** mean "cannot be
 * imported" — a monorepo is legitimately attached once per kind (GP-100).
 */
export type DiscoveredRepoWithAttachments = DiscoveredRepo & {
  attachments: RepoAttachment[];
};

export type DiscoveryPage = {
  repositories: DiscoveredRepoWithAttachments[];
  /** Opaque; pass it back verbatim for the next page. Null on the last one. */
  nextCursor: string | null;
  /** How many repositories match the current search, across every page. */
  total: number;
};

type CacheEntry = { repos: DiscoveredRepo[]; expiresAt: number };

const cache = new Map<string, CacheEntry>();

const cacheKey = (orgId: string, credentialId: string): string =>
  `${orgId}:${credentialId}`;

/**
 * Drop a cached scope. Called after an import (the attachment badges would
 * otherwise lie for up to a minute) and by tests.
 */
export function invalidateDiscoveryCache(
  orgId?: string,
  credentialId?: string,
): void {
  if (!orgId) return cache.clear();
  if (credentialId) {
    cache.delete(cacheKey(orgId, credentialId));
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${orgId}:`)) cache.delete(key);
  }
}

/** Every repository the connection can reach, from cache or from the provider. */
async function scopeOf(
  app: FastifyInstance,
  orgId: string,
  connection: IntegrationCredentialRow,
  discoverer: RepoDiscoverer,
  nowMs: number,
): Promise<DiscoveredRepo[]> {
  const key = cacheKey(orgId, connection.id);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > nowMs) return cached.repos;

  const credential = strategyForCredential(app, connection);
  const seen = new Set<string>();
  const repos: DiscoveredRepo[] = [];
  let cursor: string | null | undefined = undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await discoverer.listRepositories(
      { credential, config: connection.config },
      cursor,
    );
    for (const repo of result.repos) {
      // Providers have been known to repeat a row across page boundaries when
      // the underlying list shifts mid-pagination. Deduplicating on the
      // provider's own id is what makes "no repo lost nor duplicated" true.
      if (seen.has(repo.externalId)) continue;
      seen.add(repo.externalId);
      repos.push(repo);
    }
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  cache.set(key, { repos, expiresAt: nowMs + CACHE_TTL_MS });
  return repos;
}

/** Every attachment in this org, keyed by normalized clone URL. */
export async function attachmentsByUrl(
  app: FastifyInstance,
  orgId: string,
): Promise<Map<string, RepoAttachment[]>> {
  const rows = await app.db
    .select({
      repoId: repositories.id,
      projectId: repositories.projectId,
      url: repositories.url,
      kind: repositories.iacType,
      path: repositories.terraformPath,
    })
    .from(repositories)
    .innerJoin(projects, eq(repositories.projectId, projects.id))
    .where(eq(projects.organizationId, orgId));

  const byUrl = new Map<string, RepoAttachment[]>();
  for (const row of rows) {
    const key = repoUrlKey(row.url);
    const list = byUrl.get(key) ?? [];
    list.push({
      repoId: row.repoId,
      projectId: row.projectId,
      kind: row.kind,
      path: row.path,
    });
    byUrl.set(key, list);
  }
  return byUrl;
}

/**
 * One page of discovery for an org's connection: the provider's scope, filtered
 * by `search`, sliced by our own cursor, and annotated with what this org has
 * already attached.
 */
export async function discoverRepositories(
  app: FastifyInstance,
  args: {
    orgId: string;
    connection: IntegrationCredentialRow;
    discoverer: RepoDiscoverer;
    search?: string;
    cursor?: string;
    limit?: number;
    nowMs?: number;
  },
): Promise<DiscoveryPage> {
  const nowMs = args.nowMs ?? Date.now();
  const scope = await scopeOf(
    app,
    args.orgId,
    args.connection,
    args.discoverer,
    nowMs,
  );

  // Server-side filtering on the full name — the caller searches the whole
  // installation, not the page it happens to be holding.
  const needle = args.search?.trim().toLowerCase() ?? "";
  const matching = needle
    ? scope.filter((repo) => repo.fullName.toLowerCase().includes(needle))
    : scope;

  const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = decodeCursor(args.cursor);
  const slice = matching.slice(offset, offset + limit);
  const end = offset + slice.length;

  const attachments = await attachmentsByUrl(app, args.orgId);
  return {
    repositories: slice.map((repo) => ({
      ...repo,
      attachments: attachments.get(repoUrlKey(repo.cloneUrl)) ?? [],
    })),
    nextCursor: end < matching.length ? encodeCursor(end) : null,
    total: matching.length,
  };
}

/**
 * The cursor is an offset, base64url'd so nobody reads it as a promise about
 * how the list is stored. A cursor we cannot make sense of starts from the
 * beginning: a corrupt bookmark should show the first page, never an error.
 */
function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const offset = Number.parseInt(decoded.replace(/^o:/, ""), 10);
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

/**
 * The connection discovery should use for a provider, or a typed refusal.
 *
 * An org with exactly one connection needs no choosing; an org with several
 * (two GitHub organizations, say) must say which, because guessing would import
 * from the wrong account. Neither case is an exception — both are answers the
 * UI renders.
 */
export function resolveDiscoveryConnection(args: {
  provider: string;
  credentialId?: string;
  connections: IntegrationCredentialRow[];
}):
  | { ok: true; connection: IntegrationCredentialRow }
  | { ok: false; error: DiscoveryError; candidates: IntegrationCredentialRow[] } {
  const { connections } = args;
  if (args.credentialId) {
    const chosen = connections.find((row) => row.id === args.credentialId);
    if (chosen) return { ok: true, connection: chosen };
    return {
      ok: false,
      error: new DiscoveryError(
        "installation_not_linked",
        "that connection does not exist in this organization",
      ),
      candidates: connections,
    };
  }
  if (connections.length === 1) return { ok: true, connection: connections[0]! };
  if (connections.length === 0) {
    return {
      ok: false,
      error: new DiscoveryError(
        "installation_not_linked",
        `no ${args.provider} connection is linked to this organization — connect one before importing repositories`,
      ),
      candidates: [],
    };
  }
  return {
    ok: false,
    error: new DiscoveryError(
      "multiple_connections",
      "this organization has several connections for this provider — choose which one to import from",
    ),
    candidates: connections,
  };
}

/** The org's connections for one provider, oldest first. */
export function connectionsForProvider(
  app: FastifyInstance,
  orgId: string,
  provider: ProviderId,
): Promise<IntegrationCredentialRow[]> {
  return app.db
    .select()
    .from(integrationCredentials)
    .where(
      and(
        eq(integrationCredentials.organizationId, orgId),
        eq(integrationCredentials.provider, provider),
      ),
    )
    .orderBy(asc(integrationCredentials.createdAt));
}
