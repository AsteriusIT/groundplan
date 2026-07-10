/**
 * Drizzle schema — the core entities (GP-3).
 *
 * A Project has many Repositories. Deleting a Project cascades to its repos.
 */
import { relations } from "drizzle-orm";
import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const repositoryProvider = pgEnum("repository_provider", [
  "github",
  "gitlab",
]);

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
  // Optional token for cloning private repos. Write-only: it is set via the
  // API but MUST NOT appear in any response (see publicRepositoryColumns).
  accessToken: text("access_token"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Column set for repository responses — everything EXCEPT access_token.
 * Use this for every `.select(...)` / `.returning(...)` that leaves the API.
 */
export const publicRepositoryColumns = {
  id: repositories.id,
  projectId: repositories.projectId,
  provider: repositories.provider,
  url: repositories.url,
  defaultBranch: repositories.defaultBranch,
  createdAt: repositories.createdAt,
};

export const projectsRelations = relations(projects, ({ many }) => ({
  repositories: many(repositories),
}));

export const repositoriesRelations = relations(repositories, ({ one }) => ({
  project: one(projects, {
    fields: [repositories.projectId],
    references: [projects.id],
  }),
}));

export type Project = typeof projects.$inferSelect;
export type Repository = typeof repositories.$inferSelect;
