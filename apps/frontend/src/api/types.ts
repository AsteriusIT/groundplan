/**
 * Types mirroring the backend base models, field-for-field with the JSON the
 * API actually returns (GP-3, GP-6). Timestamps are ISO strings over the wire.
 */

export type Provider = "github" | "gitlab";

export interface Project {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface Repository {
  id: string;
  projectId: string;
  provider: Provider;
  url: string;
  defaultBranch: string;
  createdAt: string;
}

/** Create-repository response — includes the webhook token, shown once. */
export interface CreatedRepository extends Repository {
  webhookToken: string;
}

/** The current user, as returned by GET /me (note: snake_case display_name). */
export interface User {
  id: string;
  email: string | null;
  display_name: string | null;
}

export interface CreateProjectInput {
  name: string;
  slug: string;
}

export interface CreateRepositoryInput {
  provider: Provider;
  url: string;
  defaultBranch?: string;
  /** Optional token for cloning private repos (write-only server-side). */
  accessToken?: string;
}
