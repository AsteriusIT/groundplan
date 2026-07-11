/**
 * Drizzle schema — the core entities (GP-3).
 *
 * A Project has many Repositories. Deleting a Project cascades to its repos.
 */
import { relations, sql } from "drizzle-orm";
import {
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
]);

export const repositoryConnectionStatus = pgEnum(
  "repository_connection_status",
  ["unverified", "ok", "failed"],
);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
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
