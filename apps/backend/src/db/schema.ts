/**
 * Drizzle schema — the core entities (GP-3).
 *
 * A Project has many Repositories. Deleting a Project cascades to its repos.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
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

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
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
  // The subdirectory the repository's Terraform lives in; "" (the default) is
  // the repository root. Stored normalized (see lib/repo-path). It selects the
  // *entrypoint* of the HCL parse, the way `terraform -chdir` does — plan
  // snapshots arrive from CI as JSON and are unaffected.
  terraformPath: text("terraform_path").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type RepositoryRow = typeof repositories.$inferSelect;

export type PublicRepository = {
  id: string;
  projectId: string;
  provider: (typeof repositoryProvider.enumValues)[number];
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

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  oidcSubject: text("oidc_subject").notNull().unique(),
  email: text("email"),
  displayName: text("display_name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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

/** Event columns for list responses — everything EXCEPT the (large) payload. */
export const publicEventColumns = {
  id: ingestionEvents.id,
  ref: ingestionEvents.ref,
  commitSha: ingestionEvents.commitSha,
  event: ingestionEvents.event,
  parseError: ingestionEvents.parseError,
  receivedAt: ingestionEvents.receivedAt,
};

export const graphSnapshotSource = pgEnum("graph_snapshot_source", [
  "plan",
  "hcl",
]);

/**
 * A versioned, source-agnostic graph of Terraform resources (GP-12). Produced
 * either from a plan.json (`source=plan`, PR flow) or a static HCL parse
 * (`source=hcl`, docs flow). Everything in the product renders from `graph`.
 */
export const graphSnapshots = pgTable("graph_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id")
    .notNull()
    .references(() => repositories.id, { onDelete: "cascade" }),
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
});

export type GraphSnapshotRow = typeof graphSnapshots.$inferSelect;

/** Snapshot columns for list responses — everything EXCEPT the (large) graph. */
export const publicSnapshotColumns = {
  id: graphSnapshots.id,
  repositoryId: graphSnapshots.repositoryId,
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

export const projectsRelations = relations(projects, ({ many }) => ({
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
