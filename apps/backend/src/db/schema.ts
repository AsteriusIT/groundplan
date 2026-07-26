/**
 * Drizzle schema — the core entities (GP-3).
 *
 * A Project has many Repositories. Deleting a Project cascades to its repos.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import type { Graph, GraphStats } from "../graph/graph.js";
import type { PolicyDelta } from "../graph/policy/diff.js";
import type { PolicyConfig, PolicyReport } from "../graph/policy/types.js";

export const repositoryProvider = pgEnum("repository_provider", [
  "github",
  "gitlab",
  "azure_devops",
  "generic",
]);

export const repositoryConnectionStatus = pgEnum(
  "repository_connection_status",
  ["unverified", "ok", "failed"],
);

/**
 * What a repository holds (GP-101). `terraform` is everything that came before
 * and stays the default, so every existing row reads correctly with no backfill.
 *
 * One repository is one kind, not both (GP-100): a monorepo holding both can be
 * attached twice with different paths, which costs one row and buys a rule we
 * never have to reason around.
 */
export const repositoryIacType = pgEnum("repository_iac_type", [
  "terraform",
  "kubernetes",
]);

/**
 * How a credential is obtained (GP-192) — the pluggable half of the integration
 * abstraction. `pat` is the long-lived token a human pasted (and the only mode a
 * self-hosted/air-gapped install can rely on); `oauth2` is an authorization-code
 * grant whose refresh token we renew; `installation_app` is an app installed on
 * an organization, minting short-lived tokens from a private key. Mirrors
 * `CredentialMode` in `integrations/types.ts`; enum values are forever.
 */
export const credentialMode = pgEnum("credential_mode", [
  "pat",
  "oauth2",
  "installation_app",
]);

/**
 * A connection's health (GP-192). `reconnect_required` is the one state that
 * needs a human: the provider refused the credential and no retry will fix it
 * (revoked installation, refresh token rejected). Anything transient stays `ok`
 * with the error recorded — the poller must not flip a live connection because
 * of one bad night on the network.
 */
export const credentialStatus = pgEnum("credential_status", [
  "unverified",
  "ok",
  "reconnect_required",
]);

/**
 * The non-secret half of a credential, discriminated in practice by the row's
 * `provider` + `mode`. Deliberately flat and all-optional, like the graph
 * schema: a new mode populates new fields and old rows stay byte-identical.
 * The secret is NOT here — it lives in its own encrypted column, so it can
 * never leak through a config read.
 */
export type IntegrationCredentialConfig = {
  /** GitHub App installation id (`installation_app`). */
  installationId?: number;
  /** Login of the account (org or user) the installation/connection covers. */
  account?: string | null;
  /** Instance origin: self-managed GitLab, an ADO organization, an Atlassian site. */
  instanceUrl?: string | null;
  /** Atlassian cloud id — the `/ex/confluence/{cloudId}` path segment (GP-197). */
  cloudId?: string | null;
  /** Scopes the provider actually granted, verbatim from the token response. */
  scope?: string | null;
};

/**
 * An organization-level credential for a git/collaboration provider (GP-192):
 * one GitHub App installation, one GitLab OAuth connection, one Entra ID
 * consent — attachable by N repositories, exactly like the Confluence
 * Integration of GP-183.
 *
 * The `secret` follows the uniform secret rules (PATs, kubeconfigs, Confluence
 * credentials): AES-256-GCM encrypted at rest, WRITE-ONLY, never logged. It is
 * null for `installation_app`, whose only secret is the app private key in the
 * environment — nothing per-installation is worth storing.
 *
 * Repository PATs deliberately stay in `repositories.access_token`: that column
 * *is* the `pat` strategy's payload, it is already encrypted under the same
 * rules, and moving it would be a data migration that buys no behaviour. The
 * strategy layer reads both and the rest of the code sees neither.
 */
export const integrationCredentials = pgTable("integration_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  provider: repositoryProvider("provider").notNull(),
  mode: credentialMode("mode").notNull(),
  /** Display name for the connection list ("acme-corp", "GitLab · gitlab.com"). */
  name: text("name").notNull(),
  config: jsonb("config")
    .$type<IntegrationCredentialConfig>()
    .notNull()
    .default({}),
  /** AES-256-GCM ciphertext of the refresh token / PAT; null for an App install. */
  secret: text("secret"),
  status: credentialStatus("status").notNull().default("unverified"),
  /** Why the connection last failed, cleared on the next success. Never a token. */
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type IntegrationCredentialRow = typeof integrationCredentials.$inferSelect;

export type PublicIntegrationCredential = {
  id: string;
  organizationId: string;
  provider: (typeof repositoryProvider.enumValues)[number];
  mode: (typeof credentialMode.enumValues)[number];
  name: string;
  config: IntegrationCredentialConfig;
  status: (typeof credentialStatus.enumValues)[number];
  lastError: string | null;
  createdAt: Date;
};

/** Map a credential row to its API shape. The secret has no masked form here —
 * it is simply absent: nothing outside the strategy layer has any use for it. */
export function toPublicIntegrationCredential(
  row: IntegrationCredentialRow,
): PublicIntegrationCredential {
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider,
    mode: row.mode,
    name: row.name,
    config: row.config,
    status: row.status,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The organization that owns this project (GP-113). Every project belongs to
  // exactly one org; deleting the org cascades to its projects (and, through
  // them, their repositories and snapshots). Backfilled to a "Default" org for
  // rows that predate multi-tenancy — see the 0029 migration.
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // GP-60: long-form markdown "context" — what this system is, its domains and
  // conventions. The primary corpus the future AI layer reads (ADR #3).
  contextMd: text("context_md"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const repositories = pgTable("repositories", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  provider: repositoryProvider("provider").notNull(),
  // What this repository holds (GP-101). Everything downstream — which producer
  // runs on merge, which webhook payload is accepted, which views are offered —
  // branches on this one column.
  iacType: repositoryIacType("iac_type").notNull().default("terraform"),
  url: text("url").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  // Personal access token for cloning private repos. Stored ENCRYPTED at rest
  // (AES-256-GCM ciphertext, see lib/encryption). Write-only: set via the API,
  // never returned — responses mask it as "***" (see toPublicRepository).
  //
  // GP-192: this is the `pat` credential strategy's payload. When
  // `credentialId` is set, an org connection authenticates instead and this
  // column is left alone — so switching to a GitHub App and back is reversible.
  accessToken: text("access_token"),
  // The org-level connection that authenticates this repository (GP-192), or
  // null for the PAT above. `set null` on delete: revoking a connection must
  // degrade the repository honestly, never delete it.
  credentialId: uuid("credential_id").references(
    () => integrationCredentials.id,
    { onDelete: "set null" },
  ),
  // Result of the last `git ls-remote` connection check (GP-11).
  connectionStatus: repositoryConnectionStatus("connection_status")
    .notNull()
    .default("unverified"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  // Static per-repository token that CI uses to authenticate to the webhook.
  // Generated at creation and shown once; excluded from list responses.
  webhookToken: text("webhook_token")
    .notNull()
    .default(sql`gen_random_uuid()::text`),
  // GP-38: when true, a PR plan snapshot posts/updates a GitHub PR comment.
  // Off by default — no GitHub calls happen until a user opts in per repo.
  prCommentsEnabled: boolean("pr_comments_enabled").notNull().default(false),
  // Last error from posting a PR comment (bad PAT scope, rate limit, …), shown
  // in repo settings. Non-fatal: ingestion never fails on a comment error.
  lastCommentError: text("last_comment_error"),
  // GP-60: long-form markdown "context" for this repository, shown on the docs
  // page and (read-only) in the share view.
  contextMd: text("context_md"),
  // The subdirectory the repository's IaC lives in; "" (the default) is the
  // repository root. Stored normalized (see lib/repo-path). It selects the
  // *entrypoint* of the HCL parse, the way `terraform -chdir` does — plan
  // snapshots arrive from CI as JSON and are unaffected.
  //
  // GP-101: the column does double duty — for an `iac_type: kubernetes` repo it
  // is the manifests directory (the UI calls it "Manifests path"). It is not
  // renamed: the meaning is "where the IaC lives", which it always was, and a
  // rename would be migration churn for zero behaviour.
  terraformPath: text("terraform_path").notNull().default(""),
  // GP-107: the ref poller's per-repository state. `lastPolledAt` is the wall
  // clock of the last `git ls-remote` tick (success or failure); `pollError` is
  // the message from the last failed tick, cleared on the next success. Kept off
  // `connectionStatus` on purpose — that column is the *verify* check (GP-11), a
  // user action, while polling is a background heartbeat; conflating them would
  // let a transient network blip overwrite a deliberate verification result.
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  pollError: text("poll_error"),
  // GP-194: when this repository last delivered a webhook we accepted. It makes
  // the poller a *safety net* rather than the only source: a repository hearing
  // from its provider is polled rarely instead of every minute. Null (every
  // existing row) means nothing changes — the poller stays its only source.
  webhookSeenAt: timestamp("webhook_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type RepositoryRow = typeof repositories.$inferSelect;

/**
 * One ref event we have already acted on (GP-194) — the deduplication key that
 * makes "webhook *and* poller" safe. A push arriving twice (the webhook, then
 * the poller's next tick) inserts once; the second insert conflicts and the
 * handler stops there.
 *
 * The key is what identifies the *fact*, not the delivery: repository + kind +
 * branch + sha. Two different deliveries describing the same fact are the same
 * row on purpose — that is the whole point.
 */
export const refEventDeliveries = pgTable(
  "ref_event_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** `push` | `branch_deleted` | `pull_request` — the normalized event kind. */
    kind: text("kind").notNull(),
    branch: text("branch").notNull(),
    sha: text("sha").notNull(),
    /** Which source got here first: `webhook` or `poller`. Diagnostics only. */
    source: text("source").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("ref_event_deliveries_fact").on(
      table.repositoryId,
      table.kind,
      table.branch,
      table.sha,
    ),
  ],
);

export type PublicRepository = {
  id: string;
  projectId: string;
  provider: (typeof repositoryProvider.enumValues)[number];
  /** What the repository holds (GP-101); set at creation, immutable in v1. */
  iacType: (typeof repositoryIacType.enumValues)[number];
  url: string;
  defaultBranch: string;
  /** "***" when a PAT is stored, otherwise null. Never the token value. */
  accessToken: "***" | null;
  /** GP-192: the org connection authenticating this repo, or null for the PAT. */
  credentialId: string | null;
  /** GP-192: which credential strategy is actually in force, for the UI. */
  authMode: (typeof credentialMode.enumValues)[number] | null;
  connectionStatus: (typeof repositoryConnectionStatus.enumValues)[number];
  verifiedAt: Date | null;
  /** GP-38: whether PR plan snapshots post a GitHub comment. */
  prCommentsEnabled: boolean;
  /** GP-38: last PR-comment error surfaced in settings, or null. */
  lastCommentError: string | null;
  /** GP-60: long-form markdown context for this repository, or null. */
  contextMd: string | null;
  /** Subdirectory the Terraform lives in; "" is the repository root. */
  terraformPath: string;
  createdAt: Date;
};

/** Which credential strategy actually authenticates this repository (GP-192). */
function repositoryAuthMode(
  row: RepositoryRow,
  connectionMode?: (typeof credentialMode.enumValues)[number] | null,
): (typeof credentialMode.enumValues)[number] | null {
  if (row.credentialId) return connectionMode ?? null;
  return row.accessToken ? "pat" : null;
}

/**
 * Map a repository row to its API shape. The PAT is masked (never the value),
 * and the webhook token is omitted (it is shown once at creation only).
 *
 * `connectionMode` is the mode of the org connection the row points at, when
 * the caller has it joined (GP-192). Omitting it on a repository that *has* a
 * connection reports `authMode: null` rather than guessing "pat" — an unknown
 * answer beats a wrong one.
 */
export function toPublicRepository(
  row: RepositoryRow,
  connectionMode?: (typeof credentialMode.enumValues)[number] | null,
): PublicRepository {
  return {
    id: row.id,
    projectId: row.projectId,
    provider: row.provider,
    iacType: row.iacType,
    url: row.url,
    defaultBranch: row.defaultBranch,
    accessToken: row.accessToken ? "***" : null,
    credentialId: row.credentialId,
    authMode: repositoryAuthMode(row, connectionMode),
    connectionStatus: row.connectionStatus,
    verifiedAt: row.verifiedAt,
    prCommentsEnabled: row.prCommentsEnabled,
    lastCommentError: row.lastCommentError,
    contextMd: row.contextMd,
    terraformPath: row.terraformPath,
    createdAt: row.createdAt,
  };
}

/**
 * How a Confluence credential authenticates (GP-179): a Confluence Cloud API
 * token (Basic `email:token`) or a Data Center PAT (`Bearer`). The REST v1 API
 * is common to both editions, so this is a header strategy, not two adapters.
 */
export const confluenceAuthType = pgEnum("confluence_auth_type", [
  "cloud_token",
  "dc_pat",
  // GP-197: an Atlassian OAuth 2.0 (3LO) app. The stored credential is a
  // refresh token we exchange for a short-lived Bearer access token, and the
  // base URL is the `api.atlassian.com/ex/confluence/{cloudId}` gateway. Added
  // to the enum rather than replacing anything — enum values are forever, and
  // the token/PAT modes remain the only option for Data Center.
  "oauth",
]);

/** Same three states as the repository check (GP-11); own enum, same reason as
 * `cluster_connection_status` below — the two travel independently, and enum
 * values are forever. */
export const confluenceConnectionStatus = pgEnum(
  "confluence_connection_status",
  ["unverified", "ok", "failed"],
);

/**
 * A repository's Confluence publish **target** (GP-179; re-homed by GP-183):
 * which org-level Integration authenticates the publish, and which space + page
 * the docs land on. One target per repository (unique below) — a page mirrors a
 * repo's main, so a second target would be a second product decision, not a row.
 *
 * The credential no longer lives here (GP-183): it moved to `integrations`, an
 * org-owned record shared across repositories. This table is now pure target —
 * no secret to mask, only a foreign key to the integration that holds one.
 */
export const confluenceConnections = pgTable("confluence_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id")
    .notNull()
    .unique()
    .references(() => repositories.id, { onDelete: "cascade" }),
  /** The org Integration (GP-183) whose credential + base URL this target
   * publishes with. No ON DELETE cascade on purpose: an integration a repo
   * references cannot be deleted (the route answers 409); this FK is the DB
   * backstop for that rule. */
  integrationId: uuid("integration_id")
    .notNull()
    .references(() => integrations.id),
  spaceKey: text("space_key").notNull(),
  // GP-180: the published page. The id is what makes publish idempotent —
  // create once, then update version n+1 in place; when Confluence answers 404
  // for it (page deleted over there), publish recreates and stores the new id.
  pageId: text("page_id"),
  /** The page's web URL, captured from the API response for the UI's link. */
  pageUrl: text("page_url"),
  lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
  /** Categorized kind of the last failed publish (auth_failed / space_not_found
   * / network), cleared on success. Shown in the UI; never an upstream body. */
  lastPublishError: text("last_publish_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ConfluenceConnectionRow = typeof confluenceConnections.$inferSelect;

export type PublicConfluenceConnection = {
  id: string;
  repositoryId: string;
  /** The org Integration that authenticates this target's publishes. */
  integrationId: string;
  spaceKey: string;
  pageUrl: string | null;
  lastPublishedAt: Date | null;
  lastPublishError: string | null;
  createdAt: Date;
};

/**
 * Map a target row to its API shape — the ONE way it reaches a response, like
 * `toPublicRepository`/`toPublicCluster`. There is no secret here to mask; the
 * credential lives on the referenced integration (`toPublicIntegration`).
 */
export function toPublicConfluenceConnection(
  row: ConfluenceConnectionRow,
): PublicConfluenceConnection {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    integrationId: row.integrationId,
    spaceKey: row.spaceKey,
    pageUrl: row.pageUrl,
    lastPublishedAt: row.lastPublishedAt,
    lastPublishError: row.lastPublishError,
    createdAt: row.createdAt,
  };
}

/**
 * The kind of external system an Integration connects to (GP-183). Only
 * `atlassian` (Confluence) today; the model is deliberately type-tagged so a
 * future Slack/Jira integration is a new enum value + a new `config` variant,
 * never a new table. Enum values are forever.
 */
export const integrationType = pgEnum("integration_type", ["atlassian"]);

/**
 * The non-secret, type-specific configuration of an Integration, stored as JSONB
 * and discriminated by the row's `type` column. Only the `atlassian` shape
 * exists today; when a second type lands this becomes a union narrowed on
 * `type`, with no schema migration. The credential is NOT here — it lives in its
 * own encrypted column, so it can never leak through a config read.
 */
export type AtlassianIntegrationConfig = {
  baseUrl: string;
  authType: (typeof confluenceAuthType.enumValues)[number];
  /** Basic-auth username for a Cloud token; null for a DC PAT or OAuth. */
  email: string | null;
  /** OAuth only (GP-197): the Atlassian site id behind the API gateway. */
  cloudId?: string | null;
  /** OAuth only: the site's human URL, for the UI and the page backlink. */
  siteUrl?: string | null;
};
export type IntegrationConfig = AtlassianIntegrationConfig;

/**
 * An organization-level Integration (GP-183): an external credential configured
 * once per org and attachable by N repositories, replacing the per-repo
 * credential of GP-179. First (and only) type: `atlassian` (Confluence). Owned
 * by an org exactly like a cluster (GP-114); deleting the org cascades.
 *
 * The credential (API token / PAT) follows the uniform secret rules (PATs,
 * kubeconfigs): AES-256-GCM encrypted at rest (lib/encryption), WRITE-ONLY —
 * responses mask it as "***" via `toPublicIntegration` — and never logged.
 */
export const integrations = pgTable("integrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  type: integrationType("type").notNull(),
  name: text("name").notNull(),
  config: jsonb("config").$type<IntegrationConfig>().notNull(),
  /** AES-256-GCM ciphertext of the API token / PAT. Never plaintext, never logged. */
  credential: text("credential").notNull(),
  /** Result of the last credential + base-URL reachability check (GP-183):
   * a verify hits the instance with the stored credential — the space is a
   * repo-level concern, checked at publish. Reuses the shared status enum. */
  connectionStatus: confluenceConnectionStatus("connection_status")
    .notNull()
    .default("unverified"),
  /** Why the last check failed, cleared on the next success (GP-197). It is
   * what turns "failed" into something actionable — an OAuth grant the user
   * revoked reads as "reconnect required", not just a red dot. */
  lastError: text("last_error"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type IntegrationRow = typeof integrations.$inferSelect;

export type PublicIntegration = {
  id: string;
  organizationId: string;
  type: (typeof integrationType.enumValues)[number];
  name: string;
  /** Non-secret config only; the credential is never part of this shape. */
  config: IntegrationConfig;
  /** Always "***" — a stored credential is never handed back, in any response. */
  credential: "***";
  connectionStatus: (typeof confluenceConnectionStatus.enumValues)[number];
  /** Why the last check failed, or null (GP-197). Never a credential. */
  lastError: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
};

/**
 * Map an integration row to its API shape — the ONE way it reaches a response,
 * like `toPublicCluster`. `config` carries no secret (the credential is its own
 * column), so it travels whole; the credential is masked to "***".
 */
export function toPublicIntegration(row: IntegrationRow): PublicIntegration {
  return {
    id: row.id,
    organizationId: row.organizationId,
    type: row.type,
    name: row.name,
    config: row.config,
    credential: "***",
    connectionStatus: row.connectionStatus,
    lastError: row.lastError,
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
  };
}

/**
 * The same three states as a repository's connection check (GP-11), for the same
 * reason. A separate Postgres enum rather than a shared one: the two travel
 * independently, and a type named `repository_connection_status` on a cluster
 * column would be a lie we could never rename away (enum values are forever).
 */
export const clusterConnectionStatus = pgEnum("cluster_connection_status", [
  "unverified",
  "ok",
  "failed",
]);

/**
 * A Kubernetes cluster we can read (GP-95) — the repository + PAT pattern
 * (GP-3/GP-11) pointed at a cluster instead of a git remote, deliberately, so
 * nothing about secret handling is invented here.
 *
 * A cluster belongs to **no project**. A project is a unit of code review — it
 * holds repositories, whose pull requests we diff and whose main branch we
 * document. A cluster is not code: it has no PR, no docs-of-main, no annotation
 * layer, and its snapshots already hang off the cluster itself (see the
 * `graph_snapshots` owner check). Filing it under a project bought nothing and
 * cost a cascade that deleted somebody's clusters when they deleted the project.
 *
 * The kubeconfig is ENCRYPTED at rest (AES-256-GCM, see lib/encryption) and
 * WRITE-ONLY: it is set through the API and never returned — responses mask it
 * as "***" (see toPublicCluster) and it is never logged. Only the **current
 * context** of the file is ever used (GP-95, lib/kubeconfig).
 */
export const clusters = pgTable("clusters", {
  id: uuid("id").primaryKey().defaultRandom(),
  // The organization that owns this cluster (GP-114). A cluster is a top-level
  // resource (it belongs to no project), but it is still a tenant's resource —
  // scoping it here is what the schema comment above always anticipated.
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** AES-256-GCM ciphertext of the kubeconfig YAML. Never plaintext, never logged. */
  kubeconfig: text("kubeconfig").notNull(),
  /** Result of the last reachability check (`/version`), GP-95. */
  connectionStatus: clusterConnectionStatus("connection_status")
    .notNull()
    .default("unverified"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ClusterRow = typeof clusters.$inferSelect;

export type PublicCluster = {
  id: string;
  name: string;
  /** Always "***" — a stored kubeconfig is never handed back, in any response. */
  kubeconfig: "***";
  connectionStatus: (typeof clusterConnectionStatus.enumValues)[number];
  verifiedAt: Date | null;
  createdAt: Date;
};

/**
 * Map a cluster row to its API shape. Like `toPublicRepository`, this is the ONE
 * way a cluster reaches a response: masking here rather than omitting by hand at
 * each call site is what makes "the kubeconfig never leaves" a property of the
 * code instead of a habit.
 */
export function toPublicCluster(row: ClusterRow): PublicCluster {
  return {
    id: row.id,
    name: row.name,
    kubeconfig: "***",
    connectionStatus: row.connectionStatus,
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
  };
}

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  oidcSubject: text("oidc_subject").notNull().unique(),
  email: text("email"),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * A member's role within an organization (GP-113). A strict hierarchy —
 * `owner > admin > member` — kept as a Postgres enum rather than a permissions
 * table (KISS): the permission matrix lives in code (`rbac/permissions.ts`,
 * GP-114), the single source both the API guard and the frontend read from.
 * Values are forever; a new tier is an additive enum value, never a rename.
 */
export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);

/**
 * A tenant (GP-113). Everything a team owns — projects (and through them repos,
 * snapshots, PRs) and live clusters (GP-114) — hangs off exactly one org. In the
 * self-hosted default (`SINGLE_ORG=true`, GP-115) there is one, seeded "Default"
 * org; in SaaS mode users create their own. The `slug` is the shareable URL
 * segment the frontend routes on (`/o/:slug`), unique like a project's.
 */
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type OrganizationRow = typeof organizations.$inferSelect;

export type PublicOrganization = {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
};

/** Map an organization row to its API shape (identity today; a seam for later). */
export function toPublicOrganization(row: OrganizationRow): PublicOrganization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.createdAt,
  };
}

/**
 * A user's membership of an organization with a role (GP-113). A user may belong
 * to several orgs with different roles; a user has at most one membership per org
 * (the unique constraint). Deleting either side cascades — a removed user or a
 * deleted org takes its memberships with it.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("memberships_user_org_unique").on(t.userId, t.organizationId),
  ],
);

export type MembershipRow = typeof memberships.$inferSelect;

/**
 * An invitation to join an org with a role (GP-116). An admin/owner mints one; it
 * is a signed single-use link they copy and send themselves (no SMTP). The token
 * is a 256-bit secret stored **hashed** (SHA-256, like a password) — the plaintext
 * is shown once at creation and never again. Accepting consumes it (sets
 * `acceptedAt`/`acceptedBy`); revoking deletes the row. `role` is admin or member,
 * never owner (ownership transfer is an org-settings action, out of scope here).
 * `email` is informational only — anyone with the link can accept.
 */
export const invitations = pgTable("invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Informational: who the inviter meant it for; never used to gate acceptance. */
  email: text("email"),
  role: memberRole("role").notNull(),
  /** SHA-256 hex of the invite token. The plaintext is never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdBy: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  acceptedBy: uuid("accepted_by").references(() => users.id, {
    onDelete: "set null",
  }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type InvitationRow = typeof invitations.$inferSelect;

export type PublicInvitation = {
  id: string;
  organizationId: string;
  email: string | null;
  role: (typeof memberRole.enumValues)[number];
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
};

/** Map an invitation row to its API shape — the token hash never leaves. */
export function toPublicInvitation(row: InvitationRow): PublicInvitation {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Global application settings — a singleton, exactly one row (`id = true`,
 * enforced by a check so a second can never be inserted). Its only occupant today
 * is the **app-wide CI webhook token**: a second token that *any* repository's
 * webhook accepts, so a whole CI estate can share one secret instead of wiring a
 * per-repository one everywhere. Null means it is not set — only per-repo tokens
 * authenticate. Stored plaintext and compared with `safeEqual`, exactly like the
 * per-repo `webhook_token` (the same shown-once-then-masked contract).
 *
 * There is no ownership model yet, so this is genuinely global (every user sees
 * and rotates the same token); when ownership lands, per-tenant settings move out.
 */
export const appSettings = pgTable(
  "app_settings",
  {
    // The singleton key — always true; the check keeps the table to one row.
    id: boolean("id").primaryKey().default(true),
    webhookToken: text("webhook_token"),
    webhookTokenSetAt: timestamp("webhook_token_set_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [check("app_settings_singleton", sql`${t.id} = true`)],
);

export type AppSettingsRow = typeof appSettings.$inferSelect;

export const ingestionEventType = pgEnum("ingestion_event_type", [
  "push",
  "pull_request",
]);

export const ingestionEvents = pgTable("ingestion_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id")
    .notNull()
    .references(() => repositories.id, { onDelete: "cascade" }),
  ref: text("ref").notNull(),
  commitSha: text("commit_sha").notNull(),
  event: ingestionEventType("event").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  // Set when Producer A (plan.json parser, GP-13) fails on this event's payload;
  // null when the payload was not a plan or parsed cleanly.
  parseError: text("parse_error"),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The last known state of a repository's remote branches (GP-107) — one row per
 * `refs/heads/*`, upserted every poll tick. It is the single source of truth for
 * *branch existence*: the ref poller compares a fresh `git ls-remote` against
 * these rows to decide what changed, and emits `MainUpdated` / `BranchUpdated` /
 * `BranchDeleted` from the diff.
 *
 * Persisting it here is what makes the poller stateless across restarts: a
 * restarted service re-reads the same rows and so replays no events for branches
 * that did not move while it was down. `refName` is the short branch name
 * (`main`, `feature/x`) — the `refs/heads/` prefix is stripped on the way in, so
 * it compares directly against `repositories.defaultBranch`.
 */
export const remoteRefs = pgTable(
  "remote_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** Short branch name (no `refs/heads/` prefix), e.g. `main`, `feature/x`. */
    refName: text("ref_name").notNull(),
    sha: text("sha").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("remote_refs_repo_ref_unique").on(t.repositoryId, t.refName)],
);

export type RemoteRefRow = typeof remoteRefs.$inferSelect;

/** Event columns for list responses — everything EXCEPT the (large) payload. */
export const publicEventColumns = {
  id: ingestionEvents.id,
  ref: ingestionEvents.ref,
  commitSha: ingestionEvents.commitSha,
  event: ingestionEvents.event,
  parseError: ingestionEvents.parseError,
  receivedAt: ingestionEvents.receivedAt,
};

/**
 * Where a graph came from. Each value names a **producer**, and the two Terraform
 * ones keep their names and their meaning forever — every value here is additive.
 *
 * The Kubernetes trio mirrors the Terraform pair on purpose (GP-100): manifests
 * committed to a repository are the HCL of Kubernetes (a static read of main), and
 * manifests rendered by the user's CI are its plan.json (what a pull request would
 * do). `k8s_namespace` is the odd one out — it is a live cluster, not a repository.
 */
export const graphSnapshotSource = pgEnum("graph_snapshot_source", [
  "plan",
  "hcl",
  // GP-97: one namespace of a live Kubernetes cluster, read and mapped (GP-96).
  "k8s_namespace",
  // GP-102: the YAML manifests of a repository's default branch — its living docs.
  "k8s_manifest",
  // GP-103: manifests rendered by the user's CI (`helm template`, `kustomize
  // build`, or plain YAML) for a pull request head, coloured against main.
  "k8s_rendered",
]);

/**
 * A versioned, source-agnostic graph (GP-12). Produced from a plan.json
 * (`source=plan`, PR flow), a static HCL parse (`source=hcl`, docs flow), or a
 * live Kubernetes namespace read (`source=k8s_namespace`, GP-97). Everything in
 * the product renders from `graph` — which is exactly why a third producer needed
 * no new table and no new read path.
 *
 * A snapshot belongs to a **repository or a cluster, never both and never
 * neither** — the check constraint below is that sentence, enforced. `namespace`
 * is set only for the Kubernetes kind, and `ref` carries the namespace name there
 * (a live read has no commit, so `commit_sha` is empty).
 */
export const graphSnapshots = pgTable(
  "graph_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Set for plan/hcl snapshots; null for a Kubernetes namespace read. */
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "cascade",
    }),
    /** Set for `k8s_namespace` snapshots; null for the Terraform sources. */
    clusterId: uuid("cluster_id").references(() => clusters.id, {
      onDelete: "cascade",
    }),
    /** The namespace this snapshot is of; null for the Terraform sources. */
    namespace: text("namespace"),
    source: graphSnapshotSource("source").notNull(),
    ref: text("ref").notNull(),
    commitSha: text("commit_sha").notNull(),
    /** Set for plan snapshots tied to a pull request; null for docs snapshots. */
    prNumber: integer("pr_number"),
    graph: jsonb("graph").$type<Graph>().notNull(),
    /** Node/edge/change counts (+ optional warnings), computed on insert. */
    stats: jsonb("stats").$type<GraphStats & Record<string, unknown>>().notNull(),
    /**
     * Deterministic, rule-based Markdown change summary (GP-36), computed on
     * insert. Rendered at the top of the PR view and by the PR comment (GP-38).
     */
    summaryMd: text("summary_md").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "graph_snapshots_owner_check",
      sql`(${t.repositoryId} is not null) <> (${t.clusterId} is not null)`,
    ),
  ],
);

export type GraphSnapshotRow = typeof graphSnapshots.$inferSelect;

/** Snapshot columns for list responses — everything EXCEPT the (large) graph. */
export const publicSnapshotColumns = {
  id: graphSnapshots.id,
  repositoryId: graphSnapshots.repositoryId,
  clusterId: graphSnapshots.clusterId,
  namespace: graphSnapshots.namespace,
  source: graphSnapshots.source,
  ref: graphSnapshots.ref,
  commitSha: graphSnapshots.commitSha,
  prNumber: graphSnapshots.prNumber,
  stats: graphSnapshots.stats,
  createdAt: graphSnapshots.createdAt,
};

export const shareTokenKind = pgEnum("share_token_kind", [
  "docs_latest",
  "snapshot",
]);

/**
 * A public, read-only share link for a docs snapshot (GP-39). `docs_latest`
 * always resolves to the newest docs snapshot of the repository; `snapshot`
 * pins one specific snapshot. The `token` is a URL-safe secret shown to the
 * creator so they can hand out the link; the public routes look it up (and
 * refuse revoked ones). `expires_at` is reserved — enforcement is a later story.
 */
export const shareTokens = pgTable("share_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  token: text("token").notNull().unique(),
  repositoryId: uuid("repository_id")
    .notNull()
    .references(() => repositories.id, { onDelete: "cascade" }),
  kind: shareTokenKind("kind").notNull(),
  /** Set when kind = "snapshot" (pinned); null for docs_latest. */
  snapshotId: uuid("snapshot_id").references(() => graphSnapshots.id, {
    onDelete: "cascade",
  }),
  createdBy: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export type ShareTokenRow = typeof shareTokens.$inferSelect;

export const pullRequestState = pgEnum("pull_request_state", ["open", "closed"]);

/**
 * A pull request (GP-14), fed exclusively by the CI webhook — Groundplan does
 * not call the git provider API. Upserted per repo+number; plan snapshots link
 * to it by `pr_number`.
 */
export const pullRequests = pgTable(
  "pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title"),
    state: pullRequestState("state").notNull().default("open"),
    /**
     * When the PR was soft-closed (GP-109) — set the moment the ref poller sees
     * its branch deleted from the remote, null while open. Git decides existence;
     * closing keeps every snapshot and diagram, so the past stays viewable.
     * Merged vs cancelled is not distinguished — a squash merge makes it
     * undecidable from git alone, so we store nothing and the UI says "Closed".
     */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    sourceRef: text("source_ref").notNull(),
    latestCommitSha: text("latest_commit_sha").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("pull_requests_repository_number_unique").on(t.repositoryId, t.number)],
);

export type PullRequestRow = typeof pullRequests.$inferSelect;

/**
 * The five annotation kinds (GP-71). `link` is the epic's **logical_edge** — the
 * name predates it (GP-56) and means exactly the same thing: a human-drawn edge
 * the generated graph cannot know about. It is kept rather than renamed, because
 * renaming an enum value rewrites the type and would strand existing rows.
 */
export const annotationType = pgEnum("annotation_type", [
  "note",
  "link",
  "group",
  "hide",
  "rename",
]);

/**
 * `resolved` is the epic's **accepted**: the annotation is live and every anchor
 * points at a node that exists. `proposed` (GP-75) is an AI suggestion awaiting a
 * human decision — nothing but an explicit PATCH ever moves it out of that state.
 * `orphaned` (GP-57) means an anchored address vanished from the latest snapshot.
 */
export const annotationStatus = pgEnum("annotation_status", [
  "resolved",
  "orphaned",
  "proposed",
]);

/** Who authored the annotation: a person, or the proposer model (GP-75). */
export const annotationProvenance = pgEnum("annotation_provenance", [
  "human",
  "ai",
]);

/**
 * A human annotation layer (GP-56, extended GP-71), stored per repository and
 * kept strictly separate from the generated GraphSnapshot (ADR #4). Five types,
 * anchored to Terraform addresses (a node's `id`):
 *   - `note`   — 1 anchor, free markdown `body`.
 *   - `link`   — exactly 2 anchors + optional `label` (the logical edge). Each
 *                anchor is a Terraform address *or* the id of a `group`
 *                annotation, which is how a group→group edge is expressed.
 *   - `group`  — 1+ anchors + `label`; nests one level via `parentGroupId`.
 *   - `hide`   — 1 anchor; drops the node from the adapted projection (GP-72).
 *   - `rename` — 1 anchor + `label`; the node's display label in the projection.
 *
 * `status` is owned by reconciliation (GP-57/GP-71): an anchor whose address no
 * longer exists flips the annotation to `orphaned`. Orphaning is a status flip,
 * never a delete, and it reverses itself if the address comes back.
 */
export const annotations = pgTable("annotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id")
    .notNull()
    .references(() => repositories.id, { onDelete: "cascade" }),
  type: annotationType("type").notNull(),
  /** Terraform addresses this annotation is anchored to (node ids). */
  anchors: jsonb("anchors").$type<string[]>().notNull(),
  /** Required for group/rename; optional for link and note. */
  label: text("label"),
  /** Markdown body — notes only. */
  body: text("body"),
  status: annotationStatus("status").notNull().default("resolved"),
  provenance: annotationProvenance("provenance").notNull().default("human"),
  /**
   * Why the proposer suggested this (GP-75) — one sentence, shown to the reviewer.
   * A suggestion you must accept or reject without knowing *why* it was made is a
   * suggestion you will rubber-stamp, which defeats the point of asking. Null for
   * human annotations: a person's reasons are their own.
   */
  reason: text("reason"),
  /**
   * The commit the annotation was made against (GP-71) — provenance for a human
   * reviewing a stale or orphaned annotation ("this was drawn on a tree that no
   * longer looks like this"). Never used to re-anchor automatically.
   */
  createdFromSha: text("created_from_sha"),
  /**
   * The group this group nests inside (`group` annotations only). Groups nest
   * **one level**: a group whose parent already has a parent is rejected (422),
   * which keeps the C4 mapping honest — top-level groups are systems, their
   * children are containers (GP-77). Deleting a parent un-nests its children
   * rather than deleting them — an annotation is never removed on our initiative.
   */
  parentGroupId: uuid("parent_group_id").references(
    (): AnyPgColumn => annotations.id,
    { onDelete: "set null" },
  ),
  /**
   * Anchors whose Terraform address no longer exists in the latest snapshot
   * (GP-57). Empty when `status` is `resolved`; populated by reconciliation so
   * the orphan-review UI (GP-59) can show what was lost.
   */
  missingAnchors: jsonb("missing_anchors")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  createdBy: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AnnotationRow = typeof annotations.$inferSelect;

export type PublicAnnotation = {
  id: string;
  repositoryId: string;
  type: (typeof annotationType.enumValues)[number];
  anchors: string[];
  label: string | null;
  body: string | null;
  status: (typeof annotationStatus.enumValues)[number];
  provenance: (typeof annotationProvenance.enumValues)[number];
  /** Why the proposer suggested this (GP-75); null for human annotations. */
  reason: string | null;
  createdFromSha: string | null;
  parentGroupId: string | null;
  /** Anchors gone missing in the latest snapshot; empty when resolved (GP-57). */
  missingAnchors: string[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Map an annotation row to its API shape (identity today; a seam for later). */
export function toPublicAnnotation(row: AnnotationRow): PublicAnnotation {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    type: row.type,
    anchors: row.anchors,
    label: row.label,
    body: row.body,
    status: row.status,
    provenance: row.provenance,
    reason: row.reason,
    createdFromSha: row.createdFromSha,
    parentGroupId: row.parentGroupId,
    missingAnchors: row.missingAnchors,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * How an organization configured the built-in rules (GP-201), and how one
 * repository overrides that. One document per scope rather than a row per rule:
 * a configuration is read whole (every evaluation needs all of it) and written
 * whole, so a table of rows would only add joins and a partial-write race.
 *
 * `repository_id` null = the organization's document; set = that repository's
 * override, which is **partial** and merged per rule over the org's. Resolution
 * is always catalogue defaults → organization → repository, and the result
 * travels inside the report it produced (GP-200), so a stored verdict stays
 * readable after the configuration moves on.
 *
 * A rule id that no longer exists in the catalogue is simply ignored at
 * resolution — configuration must never be able to break an evaluation.
 */
export const policyConfigs = pgTable(
  "policy_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null for the org-wide document; set for a repository's override. */
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "cascade",
    }),
    /** rule id → what this scope changes about that rule (all fields optional). */
    rules: jsonb("rules")
      .$type<PolicyConfig>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedBy: uuid("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Postgres treats NULLs as distinct in a unique constraint, so this pins one
    // override per repository while leaving the org documents to the index below.
    unique("policy_configs_repository_unique").on(t.repositoryId),
    uniqueIndex("policy_configs_org_unique")
      .on(t.organizationId)
      .where(sql`${t.repositoryId} is null`),
  ],
);

export type PolicyConfigRow = typeof policyConfigs.$inferSelect;

/**
 * The policy engine's verdict on one snapshot (GP-200), stored **beside** the
 * snapshot and never inside it — the rule the annotation layer follows (ADR #4).
 * A snapshot is what the code said; a report is what we made of it, and keeping
 * the two apart is what lets the engine be re-run when the configuration changes
 * without ever rewriting a graph.
 *
 * One row per snapshot (the unique key): re-evaluating replaces the verdict for
 * that snapshot rather than accumulating verdicts. History is kept the way the
 * product keeps history everywhere else — each docs snapshot of main has its own
 * row, so the timeline can show what a past version was judged to be, under the
 * configuration that judged it (which travels inside `report.rules`).
 */
export const policyReports = pgTable(
  "policy_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => graphSnapshots.id, { onDelete: "cascade" }),
    /** Denormalized from the snapshot so per-repository reads need no join. */
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "cascade",
    }),
    report: jsonb("report").$type<PolicyReport>().notNull(),
    /**
     * How this snapshot's violations compare with the documentation of main at
     * the moment it was judged (GP-202) — new, resolved, pre-existing. Null for
     * a report *of* main, which has nothing to be compared against.
     *
     * Stored rather than derived on read: the pull-request comment and the
     * review view must say the same thing, and main moves under both of them.
     */
    delta: jsonb("delta").$type<PolicyDelta>(),
    /** Deterministic Markdown of the report, rendered on write (GP-200). */
    summaryMd: text("summary_md").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("policy_reports_snapshot_unique").on(t.snapshotId)],
);

export type PolicyReportRow = typeof policyReports.$inferSelect;

export const aiGenerationKind = pgEnum("ai_generation_kind", [
  "pr_summary",
  "docs_explain",
  // Not prose: the proposer's raw JSON (GP-75), cached under the same key so a
  // second ask for the same snapshot costs nothing.
  "annotation_proposals",
  // Also JSON: a guided tour of a snapshot (GP-78). Which one you get is decided
  // by the snapshot's source — a plan is a change to walk through, an hcl
  // snapshot is a system to be shown around.
  "change_tour",
  "system_tour",
]);

/**
 * Cached AI prose (GP-62). One row per (kind, target, prompt version, model) —
 * that tuple is the cache key, so a new plan/docs snapshot (new `target_id`), an
 * edited prompt file (new `prompt_version`, which is a hash of its contents) or a
 * different `AI_MODEL` all miss the cache and regenerate naturally.
 *
 * `target_id` is a `graph_snapshots.id` today but stays a plain text column: the
 * table is the generic cache for every future generation kind, not just snapshots.
 * Regenerating = delete the row, then generate again. Failed generations are NOT
 * stored — caching an error would serve it forever.
 */
export const aiGenerations = pgTable(
  "ai_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: aiGenerationKind("kind").notNull(),
    /** What this prose is about — a snapshot id for both kinds today. */
    targetId: text("target_id").notNull(),
    /** Short content hash of the prompt file the output was generated from. */
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    output: text("output").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("ai_generations_cache_key_unique").on(
      t.kind,
      t.targetId,
      t.promptVersion,
      t.model,
    ),
  ],
);

export type AiGenerationRow = typeof aiGenerations.$inferSelect;

export type PublicAiGeneration = {
  kind: (typeof aiGenerationKind.enumValues)[number];
  targetId: string;
  model: string;
  output: string;
  /** Token usage of the call that produced this row; null if the provider omitted it. */
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date;
};

/** Map a cached generation to its API shape (the prompt version stays internal). */
export function toPublicAiGeneration(row: AiGenerationRow): PublicAiGeneration {
  return {
    kind: row.kind,
    targetId: row.targetId,
    model: row.model,
    output: row.output,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    createdAt: row.createdAt,
  };
}

/**
 * A playground draft (GP-124): the HCL source files a user is sketching, saved
 * verbatim. Only the sources are stored — never the snapshot, which is
 * re-parsed on load (determinism, ADR #3), so stored drafts never migrate.
 * Strictly user-owned: no org, no project, no repository. A draft may hold HCL
 * that does not parse; validity is the parse endpoint's concern, not storage's.
 */
export const playgroundDrafts = pgTable("playground_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  files: jsonb("files")
    .$type<{ path: string; content: string }[]>()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PlaygroundDraftRow = typeof playgroundDrafts.$inferSelect;

export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(memberships),
  projects: many(projects),
  clusters: many(clusters),
  invitations: many(invitations),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  organization: one(organizations, {
    fields: [invitations.organizationId],
    references: [organizations.id],
  }),
}));

export const clustersRelations = relations(clusters, ({ one }) => ({
  organization: one(organizations, {
    fields: [clusters.organizationId],
    references: [organizations.id],
  }),
}));

export const playgroundDraftsRelations = relations(
  playgroundDrafts,
  ({ one }) => ({
    user: one(users, {
      fields: [playgroundDrafts.userId],
      references: [users.id],
    }),
  }),
);

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, {
    fields: [memberships.userId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [memberships.organizationId],
    references: [organizations.id],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.organizationId],
    references: [organizations.id],
  }),
  repositories: many(repositories),
}));

export const repositoriesRelations = relations(repositories, ({ one, many }) => ({
  project: one(projects, {
    fields: [repositories.projectId],
    references: [projects.id],
  }),
  events: many(ingestionEvents),
  snapshots: many(graphSnapshots),
  pullRequests: many(pullRequests),
  shareTokens: many(shareTokens),
  annotations: many(annotations),
  remoteRefs: many(remoteRefs),
}));

export const remoteRefsRelations = relations(remoteRefs, ({ one }) => ({
  repository: one(repositories, {
    fields: [remoteRefs.repositoryId],
    references: [repositories.id],
  }),
}));

export const annotationsRelations = relations(annotations, ({ one }) => ({
  repository: one(repositories, {
    fields: [annotations.repositoryId],
    references: [repositories.id],
  }),
}));

export const shareTokensRelations = relations(shareTokens, ({ one }) => ({
  repository: one(repositories, {
    fields: [shareTokens.repositoryId],
    references: [repositories.id],
  }),
  snapshot: one(graphSnapshots, {
    fields: [shareTokens.snapshotId],
    references: [graphSnapshots.id],
  }),
}));

export const graphSnapshotsRelations = relations(graphSnapshots, ({ one }) => ({
  repository: one(repositories, {
    fields: [graphSnapshots.repositoryId],
    references: [repositories.id],
  }),
}));

export const pullRequestsRelations = relations(pullRequests, ({ one }) => ({
  repository: one(repositories, {
    fields: [pullRequests.repositoryId],
    references: [repositories.id],
  }),
}));

export const ingestionEventsRelations = relations(ingestionEvents, ({ one }) => ({
  repository: one(repositories, {
    fields: [ingestionEvents.repositoryId],
    references: [repositories.id],
  }),
}));

export type Project = typeof projects.$inferSelect;
export type Repository = typeof repositories.$inferSelect;
export type IngestionEvent = typeof ingestionEvents.$inferSelect;
export type User = typeof users.$inferSelect;
