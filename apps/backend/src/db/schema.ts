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

export const annotationType = pgEnum("annotation_type", [
  "note",
  "link",
  "group",
]);

export const annotationStatus = pgEnum("annotation_status", [
  "resolved",
  "orphaned",
]);

/**
 * A human annotation layer (GP-56), stored per repository and kept strictly
 * separate from the generated GraphSnapshot (ADR #4). Three types, all anchored
 * to Terraform addresses (a node's `id`):
 *   - `note`  — 1 anchor, free markdown `body`.
 *   - `link`  — exactly 2 anchors (source, dest) + `label`.
 *   - `group` — 2+ anchors + `label`.
 * `status` is owned by reconciliation (GP-57): an anchor whose address no longer
 * exists in the latest snapshot flips the annotation to `orphaned`.
 */
export const annotations = pgTable("annotations", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id")
    .notNull()
    .references(() => repositories.id, { onDelete: "cascade" }),
  type: annotationType("type").notNull(),
  /** Terraform addresses this annotation is anchored to (node ids). */
  anchors: jsonb("anchors").$type<string[]>().notNull(),
  /** Required for link/group; optional label for a note. */
  label: text("label"),
  /** Markdown body — notes only. */
  body: text("body"),
  status: annotationStatus("status").notNull().default("resolved"),
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
    missingAnchors: row.missingAnchors,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const aiGenerationKind = pgEnum("ai_generation_kind", [
  "pr_summary",
  "docs_explain",
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
