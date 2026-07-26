/**
 * Local example seeding: turn `examples/terraform/*` into attached repositories
 * a developer can actually click through.
 *
 * The point is to exercise the *real* loop, not a shortcut into the database.
 * Each example becomes a genuine bare git repository under `.local/`, and the
 * app then clones it over `file://` exactly as it would clone GitHub — same
 * `readRepoTextFiles`, same producer, same annotation and waiver reconciliation,
 * same policy evaluation. Nothing here writes a graph by hand, so a seeded
 * repository can never show something the product could not have produced on its
 * own. `git ls-remote` and `git clone` speak `file://` natively, and the generic
 * provider adapter needs no credential, so the whole thing runs offline.
 *
 * Idempotent: re-running reuses the repositories, projects and snapshots it
 * already made. Commits are stamped with a fixed identity and date, so the same
 * example content always produces the same commit sha — which is what lets a
 * second run recognise its own work instead of piling up snapshots.
 *
 * Development only. The CLI refuses to run against a production environment.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";

import {
  graphSnapshots,
  memberships,
  organizations,
  projects,
  repositories,
  users,
  type RepositoryRow,
} from "../db/schema.js";
import { generateToken } from "../lib/tokens.js";
import { roleForNewMember, DEFAULT_ORG_SLUG } from "./onboarding.js";
import { docsSourceFor } from "./graph-snapshots.js";
import { getPolicyReport } from "./policy.js";
import { generateDocsSnapshot } from "./repo-docs.js";
import { verifyAndStore } from "./repository-verification.js";

const execFileAsync = promisify(execFile);

/** One example folder, and the entrypoints worth attaching it at. */
export type ExampleDefinition = {
  /** Folder name under `examples/terraform`, and the key of its project slug. */
  dir: string;
  /** Project name shown in the UI. */
  name: string;
  /** One line, stored as the project's context. */
  summary: string;
  /**
   * `terraform_path` values to attach, one repository each. A monorepo has more
   * than one; everything else is a single root (`""`).
   */
  entrypoints: string[];
};

/**
 * The examples, in the order they should appear. Kept beside the seeder rather
 * than discovered from the filesystem: a folder's *meaning* (what it is for,
 * where its entrypoints are) is not something a directory listing knows.
 */
export const EXAMPLE_CATALOG: ExampleDefinition[] = [
  {
    dir: "azure-hub-spoke",
    name: "Example · Azure hub & spoke",
    summary:
      "The network lens: vnet ⊃ subnet ⊃ vm ⊃ nic, NSG chips, load-balancer stacking, peering as one edge, one internet-exposed security group.",
    entrypoints: [""],
  },
  {
    dir: "azure-iam",
    name: "Example · Azure IAM",
    summary:
      "The permissions lens: principal → role → scope, managed identities, and why a broad scope alone is not privileged.",
    entrypoints: [""],
  },
  {
    dir: "azure-policy-clean",
    name: "Example · Policies pass",
    summary:
      "The same estate as the violations example, written so every built-in rule passes.",
    entrypoints: [""],
  },
  {
    dir: "azure-policy-violations",
    name: "Example · Policies fail",
    summary:
      "All sixteen built-in rules firing at once, each on a block that names the rule it trips.",
    entrypoints: [""],
  },
  {
    dir: "aws-three-tier",
    name: "Example · AWS three-tier",
    summary:
      "Route 53 → WAF → ALB → autoscaling group → RDS/S3/KMS, with IAM policy references drawn as edges.",
    entrypoints: [""],
  },
  {
    dir: "gcp-landing-zone",
    name: "Example · GCP landing zone",
    summary:
      "Custom-mode VPC with Cloud NAT, private GKE, Cloud SQL, and Cloud Run behind a global load balancer.",
    entrypoints: [""],
  },
  {
    dir: "multi-module-monorepo",
    name: "Example · Multi-module monorepo",
    // Two entrypoints in one repository is the whole point: the same clone
    // attached twice, at two `terraform_path`s, produces two different diagrams.
    summary:
      "Two stacks and three modules in one repository — attached twice, at stacks/platform and stacks/sandbox.",
    entrypoints: ["stacks/platform", "stacks/sandbox"],
  },
  {
    dir: "parser-edge-cases",
    name: "Example · Parser edge cases",
    summary:
      "A file that does not parse, four dangling references, heredocs, dynamic blocks, count vs for_each.",
    entrypoints: [""],
  },
];

export type SeedOptions = {
  /** Where the example folders live. Defaults to `<repo>/examples/terraform`. */
  examplesDir?: string;
  /** Where the bare git repositories are written. Defaults to `<repo>/.local/example-repos`. */
  reposDir?: string;
  /** Which organization to attach them to. Defaults to the `default` org. */
  orgSlug?: string;
  /** Rebuild the git repositories even when they already exist. */
  force?: boolean;
  /** Subset of `EXAMPLE_CATALOG` dirs to seed. Empty/omitted = all of them. */
  only?: string[];
  /**
   * What each project's slug starts with (the folder name completes it). A
   * project slug is unique across the instance, not per organization, so this is
   * the only way to seed the same examples into two organizations — and it is
   * what keeps the tests from colliding with a developer's own seeded projects
   * in the shared local database.
   */
  slugPrefix?: string;
};

/** Project slugs read `example-azure-iam` unless a caller says otherwise. */
export const DEFAULT_SLUG_PREFIX = "example-";

/** What one attached repository ended up as. */
export type SeededRepository = {
  example: string;
  projectSlug: string;
  terraformPath: string;
  url: string;
  commitSha: string;
  repositoryId: string;
  /** True when this run created the repository row (vs. found it). */
  attached: boolean;
  /** True when this run generated the docs snapshot (vs. found one for the sha). */
  documented: boolean;
  nodes: number | null;
  edges: number | null;
  /** `passing` | `warnings` | `failing`, or null when no report was stored. */
  policyStatus: string | null;
  /** Parse warnings on the snapshot — `parser-edge-cases` is supposed to have one. */
  warnings: number;
  /** Set when this repository could not be seeded; the others still are. */
  error?: string;
};

export type SeedResult = {
  organizationId: string;
  orgSlug: string;
  /** Users made members of the org by this run (0 once everyone is in). */
  membersAdded: number;
  /** Users in the org after this run. Zero means nobody has logged in yet. */
  members: number;
  repositories: SeededRepository[];
};

/** The repository root, from this file's location. Dev-only, so `src` is fine. */
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
}

/**
 * A fixed identity and timestamp for every seeded commit. Same content ⇒ same
 * sha, on every machine and every run — which is what makes the second run a
 * no-op instead of a fresh snapshot of identical files.
 */
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: "groundplan examples",
  GIT_AUTHOR_EMAIL: "examples@groundplan.local",
  GIT_COMMITTER_NAME: "groundplan examples",
  GIT_COMMITTER_EMAIL: "examples@groundplan.local",
  GIT_AUTHOR_DATE: "2020-01-01T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2020-01-01T00:00:00+00:00",
} as const;

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    ...(cwd ? { cwd } : {}),
    env: { ...process.env, ...COMMIT_ENV, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export type MaterializedRepo = {
  /** `file://…` — what the repository row stores and the app clones. */
  url: string;
  path: string;
  commitSha: string;
  /** True when this run wrote the repository (vs. found it intact). */
  created: boolean;
};

/**
 * Publish one example folder as a bare git repository with a single `main`
 * commit. Bare on purpose: a bare repository accepts pushes, so a developer can
 * clone it, branch, push and exercise the pull-request flow against it.
 */
export async function materializeExampleRepo(
  sourceDir: string,
  barePath: string,
  opts: { force?: boolean } = {},
): Promise<MaterializedRepo> {
  const url = `file://${barePath}`;
  if (!opts.force && (await exists(barePath))) {
    const head = await git(["--git-dir", barePath, "rev-parse", "main"]);
    return { url, path: barePath, commitSha: head, created: false };
  }

  await fs.rm(barePath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(barePath), { recursive: true });
  await git(["init", "--bare", "--initial-branch=main", barePath]);

  const work = await fs.mkdtemp(path.join(os.tmpdir(), "gp-seed-"));
  try {
    await fs.cp(sourceDir, work, { recursive: true });
    await git(["init", "--initial-branch=main"], work);
    await git(["add", "-A"], work);
    await git(["commit", "-m", `${path.basename(sourceDir)} example`], work);
    await git(["push", "--quiet", barePath, "main"], work);
    const head = await git(["rev-parse", "HEAD"], work);
    return { url, path: barePath, commitSha: head, created: true };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

/** The organization to seed into — it must already exist (migration 0029). */
async function resolveOrganization(
  db: NodePgDatabase,
  slug: string,
): Promise<{ id: string; slug: string }> {
  const [org] = await db
    .select({ id: organizations.id, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.slug, slug));
  if (!org) {
    throw new Error(
      `no organization with slug "${slug}" — pass --org <slug>, or run the app once so the default org exists`,
    );
  }
  return org;
}

/**
 * Make every existing user a member of the seeded org, so the data is visible
 * whichever mode the instance runs in. In single-org mode a user who has not
 * logged in yet is onboarded automatically on first request; in SaaS mode
 * nothing would otherwise connect them to the org the examples landed in.
 */
async function ensureMembers(
  db: NodePgDatabase,
  organizationId: string,
): Promise<{ added: number; total: number }> {
  const all = await db.select({ id: users.id }).from(users);
  let added = 0;
  for (const user of all) {
    const [current] = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, user.id),
          eq(memberships.organizationId, organizationId),
        ),
      );
    if (current) continue;
    const role = await roleForNewMember(db, organizationId);
    await db
      .insert(memberships)
      .values({ userId: user.id, organizationId, role })
      .onConflictDoNothing({
        target: [memberships.userId, memberships.organizationId],
      });
    added += 1;
  }
  const members = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.organizationId, organizationId));
  return { added, total: members.length };
}

async function ensureProject(
  db: NodePgDatabase,
  organizationId: string,
  example: ExampleDefinition,
  slug: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: projects.id, organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.slug, slug));
  if (existing) {
    // A project slug is unique across the whole instance, so a second
    // organization cannot have its own copy under the same name. Say so instead
    // of silently seeding into somebody else's tenant.
    if (existing.organizationId !== organizationId) {
      throw new Error(
        `project "${slug}" already exists in another organization — seed with a different --org, or a different slug prefix`,
      );
    }
    return existing.id;
  }
  const [created] = await db
    .insert(projects)
    .values({
      organizationId,
      name: example.name,
      slug,
      contextMd: example.summary,
    })
    .returning({ id: projects.id });
  return created!.id;
}

async function ensureRepository(
  db: NodePgDatabase,
  projectId: string,
  url: string,
  terraformPath: string,
): Promise<{ repo: RepositoryRow; attached: boolean }> {
  const [existing] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.projectId, projectId),
        eq(repositories.url, url),
        eq(repositories.terraformPath, terraformPath),
      ),
    );
  if (existing) return { repo: existing, attached: false };

  const [created] = await db
    .insert(repositories)
    .values({
      projectId,
      // A `file://` remote belongs to no host, so the registry's fallback
      // adapter owns it: cloneable, and honest about having no pull requests.
      provider: "generic",
      iacType: "terraform",
      url,
      defaultBranch: "main",
      terraformPath,
      webhookToken: generateToken(),
    })
    .returning();
  return { repo: created!, attached: true };
}

/** The docs snapshot already stored for this exact commit, if there is one. */
async function docsSnapshotForSha(
  db: NodePgDatabase,
  repo: RepositoryRow,
  commitSha: string,
): Promise<{ id: string; stats: unknown } | undefined> {
  const [row] = await db
    .select({ id: graphSnapshots.id, stats: graphSnapshots.stats })
    .from(graphSnapshots)
    .where(
      and(
        eq(graphSnapshots.repositoryId, repo.id),
        eq(graphSnapshots.source, docsSourceFor(repo.iacType)),
        eq(graphSnapshots.commitSha, commitSha),
      ),
    )
    .limit(1);
  return row;
}

function statNumber(stats: unknown, key: string): number | null {
  if (!stats || typeof stats !== "object") return null;
  const value = (stats as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

function warningCount(stats: unknown): number {
  if (!stats || typeof stats !== "object") return 0;
  const warnings = (stats as Record<string, unknown>)["warnings"];
  return Array.isArray(warnings) ? warnings.length : 0;
}

/**
 * Seed every example: publish it as a git repository, attach it to a project,
 * verify the connection, and generate its documentation of main.
 *
 * A failure on one example is recorded against that repository and the rest
 * still seed — one unparseable example must not cost you the other seven.
 */
export async function seedExamples(
  app: FastifyInstance,
  opts: SeedOptions = {},
): Promise<SeedResult> {
  const root = repoRoot();
  const examplesDir = opts.examplesDir ?? path.join(root, "examples", "terraform");
  const reposDir = opts.reposDir ?? path.join(root, ".local", "example-repos");
  const org = await resolveOrganization(app.db, opts.orgSlug ?? DEFAULT_ORG_SLUG);
  const { added, total } = await ensureMembers(app.db, org.id);

  const wanted = new Set(opts.only ?? []);
  const catalog =
    wanted.size > 0
      ? EXAMPLE_CATALOG.filter((e) => wanted.has(e.dir))
      : EXAMPLE_CATALOG;

  const results: SeededRepository[] = [];
  const slugOf = (example: ExampleDefinition): string =>
    `${opts.slugPrefix ?? DEFAULT_SLUG_PREFIX}${example.dir}`;

  for (const example of catalog) {
    const slug = slugOf(example);
    const sourceDir = path.join(examplesDir, example.dir);
    if (!(await exists(sourceDir))) {
      results.push(
        failure(example, slug, "", "", `no such example folder: ${sourceDir}`),
      );
      continue;
    }

    let published: MaterializedRepo;
    let projectId: string;
    try {
      published = await materializeExampleRepo(
        sourceDir,
        path.join(reposDir, `${example.dir}.git`),
        { force: opts.force ?? false },
      );
      projectId = await ensureProject(app.db, org.id, example, slug);
    } catch (err) {
      results.push(failure(example, slug, "", "", message(err)));
      continue;
    }

    for (const terraformPath of example.entrypoints) {
      try {
        const { repo, attached } = await ensureRepository(
          app.db,
          projectId,
          published.url,
          terraformPath,
        );
        // The same check the settings page runs — a seeded repository should
        // read as verified, not as "unverified" nobody ever tried.
        const { repository } = await verifyAndStore(app, repo);

        const already = await docsSnapshotForSha(
          app.db,
          repository,
          published.commitSha,
        );
        const snapshot =
          already ??
          (await generateDocsSnapshot(app, repository, { trigger: "manual" }));
        const report = await getPolicyReport(app.db, snapshot.id);

        results.push({
          example: example.dir,
          projectSlug: slug,
          terraformPath,
          url: published.url,
          commitSha: published.commitSha,
          repositoryId: repository.id,
          attached,
          documented: already === undefined,
          nodes: statNumber(snapshot.stats, "nodes"),
          edges: statNumber(snapshot.stats, "edges"),
          policyStatus: report?.report.status ?? null,
          warnings: warningCount(snapshot.stats),
        });
      } catch (err) {
        results.push(
          failure(example, slug, terraformPath, published.url, message(err)),
        );
      }
    }
  }

  return {
    organizationId: org.id,
    orgSlug: org.slug,
    membersAdded: added,
    members: total,
    repositories: results,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failure(
  example: ExampleDefinition,
  projectSlug: string,
  terraformPath: string,
  url: string,
  error: string,
): SeededRepository {
  return {
    example: example.dir,
    projectSlug,
    terraformPath,
    url,
    commitSha: "",
    repositoryId: "",
    attached: false,
    documented: false,
    nodes: null,
    edges: null,
    policyStatus: null,
    warnings: 0,
    error,
  };
}
