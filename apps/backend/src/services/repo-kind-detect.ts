/**
 * Running the detection of GP-228 against a real repository.
 *
 * `detectRepoKind` is pure; this is the thin layer that feeds it — one tree call
 * per repository through the `RepoTreeReader` port, and, only when the tree left
 * the question open, the first bytes of a handful of candidate YAML files.
 *
 * The bounded content peek is what makes "a repository of raw manifests is
 * detected `kubernetes` / high" achievable at all: `deployment.yaml` and a CI
 * workflow are the same file name, and only `apiVersion` + `kind` tells them
 * apart. It stays a peek — at most `MAX_HEAD_READS` files, never a parse, never
 * a clone.
 *
 * Results are cached beside the discovered scope (GP-227) and for the same
 * minute: the import screen detects the page it is showing, and scrolling back
 * up must not pay for it twice.
 */
import type { FastifyInstance } from "fastify";

import {
  toDiscoveryError,
  type DiscoveryConnection,
  type RepoTarget,
  type RepoTreeReader,
} from "../integrations/types.js";
import {
  detectRepoKind,
  trimSlashes,
  type FileEntry,
  type RepoKindDetection,
} from "./repo-kind.js";

/** Same TTL as the discovered scope — they are read together. */
const CACHE_TTL_MS = 60_000;

/**
 * How many candidate YAML heads we will read for one repository. Five is enough
 * to recognise a manifests directory and small enough that a page of forty
 * repositories cannot turn into a storm of requests.
 */
const MAX_HEAD_READS = 5;

/** A file whose name makes it worth a peek, but whose name proves nothing. */
const CANDIDATE_YAML = /\.ya?ml$/i;

/**
 * Directories whose YAML is never a Kubernetes manifest. Skipping them first
 * means the peek budget is spent on files that could actually answer the
 * question, rather than on three CI workflows.
 */
const NEVER_MANIFESTS = /(^|\/)(\.github|\.gitlab|\.circleci|node_modules|vendor)(\/|$)/i;

export type RepoKindResult = RepoKindDetection & {
  /** The provider truncated the tree, so nothing here can be `high`. */
  truncated: boolean;
};

type CacheEntry = { result: RepoKindResult; expiresAt: number };

const cache = new Map<string, CacheEntry>();

const cacheKey = (orgId: string, target: RepoTarget, path: string): string =>
  `${orgId}:${target.owner}/${target.name}@${target.ref}#${path}`;

/** Drop cached detections; called by an import and by tests. */
export function invalidateKindCache(orgId?: string): void {
  if (!orgId) return cache.clear();
  for (const key of cache.keys()) {
    if (key.startsWith(`${orgId}:`)) cache.delete(key);
  }
}

/**
 * Detect what one repository holds. Never throws for a repository we simply
 * could not read: an unreadable repository is `kind: null`, which the UI already
 * renders as "choose one" — the whole page must not fail because one repo did.
 */
export async function detectRepositoryKind(
  app: FastifyInstance,
  args: {
    orgId: string;
    connection: DiscoveryConnection;
    trees: RepoTreeReader;
    target: RepoTarget;
    /** Detect inside a subdirectory rather than the whole repository. */
    path?: string;
    nowMs?: number;
  },
): Promise<RepoKindResult> {
  const nowMs = args.nowMs ?? Date.now();
  const path = args.path ?? "";
  const key = cacheKey(args.orgId, args.target, path);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > nowMs) return cached.result;

  let result: RepoKindResult;
  try {
    result = await runDetection(args.connection, args.trees, args.target, path);
  } catch (err) {
    app.log.warn(
      { err: toDiscoveryError(err), repo: `${args.target.owner}/${args.target.name}` },
      "could not detect the repository kind",
    );
    // Unknown is a first-class answer here, so a failure degrades to it rather
    // than to an error the import screen would have to special-case.
    result = {
      kind: null,
      confidence: "low",
      evidence: [],
      suggestedPath: null,
      truncated: false,
    };
  }

  cache.set(key, { result, expiresAt: nowMs + CACHE_TTL_MS });
  return result;
}

async function runDetection(
  connection: DiscoveryConnection,
  trees: RepoTreeReader,
  target: RepoTarget,
  path: string,
): Promise<RepoKindResult> {
  const tree = await trees.readTree(connection, target);
  const entries: FileEntry[] = tree.entries.map((entry) => ({
    path: entry.path,
    type: entry.type,
  }));
  const scope = { truncated: tree.truncated, ...(path ? { path } : {}) };

  const first = detectRepoKind(entries, scope);
  // Reading YAML heads can only ever *add* a Kubernetes signal, so it is worth
  // doing unless one was already found. Note what this means for a repository
  // whose tree shows Terraform and nothing else: we still peek, because the
  // manifests beside it are exactly what turns it into a monorepo — and a
  // monorepo silently imported as `terraform` is an irreversible wrong answer.
  const kubernetesAlreadyFound =
    first.kind === "kubernetes" ||
    (first.kind === null && first.evidence.length > 0);
  if (kubernetesAlreadyFound) return { ...first, truncated: tree.truncated };

  const prefix = path ? `${trimSlashes(path)}/` : "";
  const candidates = entries
    .filter(
      (entry) =>
        entry.type === "file" &&
        entry.path.startsWith(prefix) &&
        CANDIDATE_YAML.test(entry.path) &&
        !NEVER_MANIFESTS.test(entry.path),
    )
    .slice(0, MAX_HEAD_READS);
  if (candidates.length === 0) return { ...first, truncated: tree.truncated };

  const heads = await Promise.all(
    candidates.map(async (entry) => {
      try {
        return await trees.readFileHead(connection, target, entry.path);
      } catch {
        return null;
      }
    }),
  );

  const withHeads = entries.map((entry) => {
    const index = candidates.findIndex((c) => c.path === entry.path);
    const head = index >= 0 ? heads[index] : null;
    return head ? { ...entry, head } : entry;
  });

  const second = detectRepoKind(withHeads, scope);
  return { ...second, truncated: tree.truncated };
}
