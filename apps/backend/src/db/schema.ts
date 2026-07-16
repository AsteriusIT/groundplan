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
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import type { Graph, GraphStats } from "../graph/graph.js";

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
  accessToken: text("access_token"),
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type RepositoryRow = typeof repositories.$inferSelect;

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

/**
 * Map a repository row to its API shape. The PAT is masked (never the value),
 * and the webhook token is omitted (it is shown once at creation only).
 */
export function toPublicRepository(row: RepositoryRow): PublicRepository {
  return {
    id: row.id,
    projectId: row.projectId,
    provider: row.provider,
    iacType: row.iacType,
    url: row.url,
    defaultBranch: row.defaultBranch,
    accessToken: row.accessToken ? "***" : null,
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
