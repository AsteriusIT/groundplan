/**
 * The integration ports (GP-192) — the seam every external system sits behind.
 *
 * Until now a "provider" was a string the core branched on (`if provider ===
 * "github"`) and a PAT column it read directly. That made a second way to
 * authenticate — a GitHub App installation, a GitLab OAuth app, Entra ID —
 * impossible to add without touching the core in a dozen places.
 *
 * Three ideas carry the whole layer:
 *
 *  1. **A credential is a strategy, not a column.** `CredentialStrategy` hands
 *     out an access token and says nothing about where it came from: a stored
 *     PAT, a refreshed OAuth token, an installation token minted seconds ago.
 *     Everything downstream (clone, ls-remote, REST call) only ever sees a
 *     token and the username to pair it with.
 *  2. **Capabilities are separate interfaces.** A provider implements what it
 *     can do — `RepoReader`, `PullRequestCommenter`, `CheckPublisher`,
 *     `RefEventSource` — and declares it. The core asks "can you comment?"
 *     instead of "are you GitHub?".
 *  3. **The registry is the only place that knows providers exist.** Adding one
 *     is a new adapter file plus a registry entry; no other file changes.
 *
 * Nothing here imports Fastify, Drizzle or a REST client: these are types the
 * adapters implement and the services consume.
 */

/** The providers we can talk to. Mirrors the `repository_provider` pg enum. */
export const PROVIDER_IDS = [
  "github",
  "gitlab",
  "azure_devops",
  "generic",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * How a credential is obtained — the pluggable half of the abstraction.
 *
 * - `pat`: a long-lived token a human pasted. Always available, everywhere,
 *   and the only mode a self-hosted/air-gapped install can rely on.
 * - `oauth2`: an authorization-code grant with a refresh token we renew
 *   (GitLab, Entra ID for Azure DevOps, Atlassian 3LO).
 * - `installation_app`: an app installed on an organization, minting short-
 *   lived installation tokens from a private key (GitHub App).
 *
 * Mirrors the `credential_mode` pg enum; values are forever.
 */
export const CREDENTIAL_MODES = ["pat", "oauth2", "installation_app"] as const;
export type CredentialMode = (typeof CREDENTIAL_MODES)[number];

/**
 * A token ready to authenticate one call. `expiresAt` is null for a PAT (it
 * expires when someone revokes it, which we learn by being refused) and a real
 * instant for the short-lived modes, so a cache can renew *before* expiry
 * rather than after a failure.
 */
export type AccessToken = { token: string; expiresAt: Date | null };

/**
 * Thrown when a credential can no longer produce a token and a human has to
 * act — a revoked installation, a refresh token the IdP rejected. Distinct
 * from a network blip on purpose: this is the one failure that flips a
 * connection to `reconnect_required` instead of being retried forever.
 */
export class CredentialRevokedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialRevokedError";
  }
}

/**
 * The pluggable credential half of an integration. Opaque to every caller: the
 * clone path, the poller and the REST clients all just await `getToken()`.
 */
export interface CredentialStrategy {
  readonly mode: CredentialMode;
  /** A token valid *now*, refreshing/minting if the cached one is stale. */
  getToken(): Promise<AccessToken>;
}

/** The capabilities a provider may declare. Feature detection, not `instanceof`. */
export const CAPABILITIES = [
  "repo:read",
  "pr:comment",
  "check:publish",
  "ref:events",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Reading a git remote: the username half of an authenticated https URL. */
export interface RepoReader {
  /**
   * Username to embed beside the token in `https://user:token@host/...`. It
   * depends on the credential mode (a GitHub App installation token is still
   * `x-access-token`; an Entra access token is not a PAT but travels the same
   * way), which is exactly why it belongs to the adapter.
   */
  cloneUsername(mode: CredentialMode): string;
}

export interface UpsertCommentArgs {
  /** The repository URL — each adapter parses out the identifiers it needs. */
  repoUrl: string;
  /** PR / MR number (GitLab MR iid). */
  prNumber: number;
  /** Hidden marker identifying our comment, for idempotent updates. */
  marker: string;
  /** Full Markdown body (already leads with the marker). */
  body: string;
  /** A token from the repository's credential strategy — never a raw column. */
  token: string;
}

/** Posting the one PR summary comment, idempotently. */
export interface PullRequestCommenter {
  upsertComment(args: UpsertCommentArgs): Promise<void>;
}

export type CheckConclusion = "success" | "neutral" | "failure";

export type PublishCheckArgs = {
  repoUrl: string;
  headSha: string;
  title: string;
  summary: string;
  conclusion: CheckConclusion;
  token: string;
};

/**
 * Publishing a commit status / check run. Declared here so the policy gate
 * (GP-199) has a port to aim at; only providers that support it implement it.
 */
export interface CheckPublisher {
  publishCheck(args: PublishCheckArgs): Promise<void>;
}

/** A ref change, however we learned about it — poll or webhook (GP-194). */
export type RefEventKind = "push" | "branch_deleted" | "pull_request";

export type RefEvent = {
  kind: RefEventKind;
  /** Short branch name (no `refs/heads/`). */
  branch: string;
  /** Head sha; for a deletion, the last sha the sender knew. */
  sha: string;
  /** Set for `pull_request` events only. */
  prNumber?: number;
  prTitle?: string;
  prState?: "open" | "closed";
  /** Clone/web URL of the repository the event is about, for resolution. */
  remoteUrl: string | null;
};

/** A webhook request reduced to what verification and parsing need. */
export type RawWebhook = {
  headers: Record<string, string | undefined>;
  /** The exact bytes we received — signatures are over the raw body. */
  rawBody: Buffer;
  /** The parsed JSON body, or null when it did not parse. */
  json: unknown;
};

/**
 * Push/PR events pushed to us instead of polled (GP-194). The poller implements
 * the same idea from the other side, which is why this is a port and not a
 * GitHub feature: a provider with no webhook support simply doesn't declare
 * `ref:events`, and the poller stays its only source.
 */
export interface RefEventSource {
  /** Constant-time signature / shared-secret check against `secret`. */
  verifySignature(hook: RawWebhook, secret: string): boolean;
  /** Normalize to our internal events; `[]` for payloads we ignore (pings…). */
  parseEvents(hook: RawWebhook): RefEvent[];
}

/**
 * What a completed connect flow yields, ready to store as an
 * `integration_credentials` row. `secret` is null for a mode whose only secret
 * lives in the environment (a GitHub App's private key).
 */
export type NewConnection = {
  /** Display name for the connection list ("acme-corp", "gitlab.com"). */
  name: string;
  config: {
    installationId?: number;
    account?: string | null;
    instanceUrl?: string | null;
    cloudId?: string | null;
    scope?: string | null;
  };
  /** Plaintext refresh token / secret to encrypt at rest, or null. */
  secret: string | null;
};

/**
 * Connecting a provider from the browser (GP-193/195/196/197). Every flow is
 * the same two steps — send the user somewhere, then finish from what comes
 * back — so the routes are provider-agnostic and the UI renders whatever the
 * registry reports. A provider with no flow can only be used with a PAT.
 *
 * `carry` is how a flow keeps a secret across the round trip (a PKCE verifier):
 * the route seals it into the opaque `state` it hands the browser, and returns
 * it here. The browser never sees its contents.
 */
export interface ConnectFlow {
  readonly mode: CredentialMode;
  start(args: { redirectUri: string }): {
    carry: Record<string, string>;
    authorizeUrl(state: string): string;
  };
  complete(args: {
    /** Query parameters of the provider's callback. */
    params: Record<string, string>;
    carry: Record<string, string>;
    redirectUri: string;
  }): Promise<NewConnection>;
}

/**
 * One external system, assembled from the capabilities it supports. The core
 * holds this, never a concrete class: `provider.commenter` is null for a
 * provider that cannot comment, and that is the whole branch.
 */
export interface IntegrationProvider {
  readonly id: ProviderId;
  /** Human label for the UI — the frontend renders the registry, not a list. */
  readonly label: string;
  /** Credential modes this provider can authenticate with, best first. */
  readonly credentialModes: readonly CredentialMode[];
  /** What this provider can do. Consulted through `supports()`. */
  readonly capabilities: readonly Capability[];
  readonly repo: RepoReader;
  readonly commenter: PullRequestCommenter | null;
  readonly checks: CheckPublisher | null;
  readonly refEvents: RefEventSource | null;
  /**
   * Browser flows this instance can actually run, by mode. Empty when the
   * deployment configured no app/client for this provider — which is exactly
   * what "not configured on this instance" means in the UI.
   */
  readonly connectFlows: readonly ConnectFlow[];
  /** Does this URL belong to this provider? (`detectProvider` asks each one.) */
  matchesUrl(url: string): boolean;
  supports(capability: Capability): boolean;
  /** The flow for one mode, or null. */
  connectFlow(mode: CredentialMode): ConnectFlow | null;
}
