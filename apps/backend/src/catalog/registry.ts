/**
 * The version watcher (GP-235): the one outbound call the catalog makes on its
 * own, and the lightest one available — `GET /v1/providers/:ns/:name/versions`
 * on the public Terraform Registry, which answers with a list of version strings
 * and nothing else.
 *
 * It exists so the expensive half (downloading a provider and running it,
 * GP-236) happens only when there is genuinely something new. The registry is
 * never asked on the request path, its answer is never required for a read to
 * succeed, and an instance that cannot reach it keeps serving its catalog — the
 * refresh is an enhancement, not a dependency (GP-239).
 *
 * The registry returns versions in no particular order, so ordering is ours to
 * do: semver, ascending, pre-releases excluded. A `4.82.0-beta1` is a provider
 * somebody may want to try by hand; it is not what a builder should be
 * generating against by default.
 */

/** The base the watcher talks to. Overridable so tests never leave the process. */
export const TERRAFORM_REGISTRY = "https://registry.terraform.io";

/**
 * A User-Agent that says who is calling. The registry is a free public service;
 * an anonymous client that cannot be contacted is one nobody can ask to stop.
 */
export const REGISTRY_USER_AGENT = "groundplan-catalog/1.0 (+https://github.com/AsteriusIT)";

/** What the watcher needs from the outside world — one call, injectable. */
export type RegistryClient = {
  /** Every version string the registry lists for a provider. */
  listVersions(ref: {
    namespace: string;
    name: string;
  }): Promise<readonly string[]>;
};

/** A semver core, with the pre-release tag that disqualifies it, if any. */
type Parsed = {
  parts: [number, number, number];
  prerelease: string | null;
};

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(raw: string): Parsed | null {
  const match = SEMVER.exec(raw.trim());
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
}

/** Is this a version a builder should be generating against? */
export function isStable(raw: string): boolean {
  return parseVersion(raw)?.prerelease === null;
}

/** Ascending semver order over the numeric core. */
function compare(a: Parsed, b: Parsed): number {
  for (let at = 0; at < 3; at += 1) {
    const diff = (a.parts[at] ?? 0) - (b.parts[at] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The newest stable version in a list, or null when it holds none — which is
 * what a provider that has only ever shipped pre-releases looks like, and is a
 * fact to record rather than an error to raise.
 */
export function latestStable(versions: readonly string[]): string | null {
  let best: { raw: string; parsed: Parsed } | null = null;
  for (const raw of versions) {
    const parsed = parseVersion(raw);
    if (!parsed || parsed.prerelease !== null) continue;
    if (!best || compare(parsed, best.parsed) > 0) best = { raw, parsed };
  }
  return best?.raw ?? null;
}

/** Is `candidate` newer than what we already know? Unknown counts as newer. */
export function isNewer(candidate: string, known: string | null): boolean {
  if (known === null) return true;
  const a = parseVersion(candidate);
  const b = parseVersion(known);
  if (!a || !b) return candidate !== known;
  return compare(a, b) > 0;
}

export type RegistryClientOptions = {
  baseUrl?: string;
  /** Per-attempt wall clock. The watcher must never hold a tick open. */
  timeoutMs?: number;
  /** Total attempts, including the first. */
  attempts?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to a real sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to `Math.random`, for the retry jitter. */
  random?: () => number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * The real client: one GET, a per-attempt timeout, and exponential backoff with
 * full jitter between attempts. Jitter rather than a fixed delay because every
 * node in a cluster ticks on the same schedule, and a fixed delay would turn a
 * registry blip into a synchronised stampede.
 */
export function createRegistryClient(
  opts: RegistryClientOptions = {},
): RegistryClient {
  const baseUrl = (opts.baseUrl ?? TERRAFORM_REGISTRY).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = Math.max(opts.attempts ?? DEFAULT_ATTEMPTS, 1);
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? wait;
  const random = opts.random ?? Math.random;

  return {
    async listVersions(ref) {
      const url = `${baseUrl}/v1/providers/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.name)}/versions`;
      let lastError: unknown;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) {
          await sleep(random() * BASE_BACKOFF_MS * 2 ** (attempt - 1));
        }
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), timeoutMs);
        timer.unref?.();
        try {
          const response = await doFetch(url, {
            signal: abort.signal,
            headers: {
              accept: "application/json",
              "user-agent": REGISTRY_USER_AGENT,
            },
          });
          if (!response.ok) {
            // A 404 is an answer, not a blip: the provider does not exist under
            // that address, and retrying twice more will not change it.
            if (response.status === 404) return [];
            throw new Error(`registry answered ${response.status}`);
          }
          const body = (await response.json()) as {
            versions?: { version?: unknown }[];
          };
          return (body.versions ?? [])
            .map((entry) => entry?.version)
            .filter((version): version is string => typeof version === "string");
        } catch (err) {
          lastError = err;
        } finally {
          clearTimeout(timer);
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error("registry unreachable");
    },
  };
}
