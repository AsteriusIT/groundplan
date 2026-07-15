/**
 * Global test-data cleanup for `node --test` (wired via `--test-global-setup`).
 *
 * The backend suite runs against the **same Postgres as local dev** — there is no
 * separate test database — so every run creates throwaway projects and clusters
 * that would otherwise accumulate forever. This removes exactly what a run
 * created, and nothing else.
 *
 * How it stays safe: it snapshots the ids that already exist *before* the suite
 * (a real project, an attached cluster), then at the end deletes only the rows
 * that are **not** in that snapshot. Pre-existing data is therefore never touched,
 * and there is no reliance on slug/name conventions. Deleting a project cascades
 * to its repositories, snapshots, remote refs and pull requests; deleting a
 * cluster cascades to its namespace snapshots.
 *
 * The one failure mode to guard is "setup never captured a baseline" — then every
 * row looks new and a blanket delete would wipe real data. So teardown does
 * nothing unless a baseline was actually taken, and both hooks are inert outside
 * `NODE_ENV=test`. As belt-and-suspenders, setup also clears any *project* junk a
 * previously **crashed** run left behind (identified by the 13-digit `Date.now()`
 * timestamp every test slug carries — a marker no human slug has) before taking
 * the snapshot.
 */
import { Pool } from "pg";

/** Ids that existed before the suite — the "real" data teardown must preserve. */
let baseline: { projects: string[]; clusters: string[] } | null = null;

/**
 * Read `DATABASE_URL` directly (matching `config/env.ts`'s default) rather than
 * importing `loadEnv`: this module is loaded by the test runner's global-setup
 * hook, which does not apply tsx's `.js`→`.ts` rewrite to its relative imports.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://groundplan:groundplan@localhost:5432/groundplan";

async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

export async function globalSetup(): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;

  await withPool(async (pool) => {
    // Clear project junk from a prior crashed run (safe: only test slugs carry a
    // 13+ digit millisecond timestamp; real slugs are human names).
    await pool.query("DELETE FROM projects WHERE slug ~ '[0-9]{13,}'");

    const projects = await pool.query<{ id: string }>("SELECT id FROM projects");
    const clusters = await pool.query<{ id: string }>("SELECT id FROM clusters");
    baseline = {
      projects: projects.rows.map((r) => r.id),
      clusters: clusters.rows.map((r) => r.id),
    };
  });
}

export async function globalTeardown(): Promise<void> {
  if (process.env.NODE_ENV !== "test") return;
  // No baseline means setup did not run to completion — deleting "everything not
  // in the baseline" would be deleting everything. Do nothing instead.
  if (!baseline) return;

  const { projects, clusters } = baseline;
  await withPool(async (pool) => {
    await pool.query("DELETE FROM projects WHERE id <> ALL($1::uuid[])", [projects]);
    await pool.query("DELETE FROM clusters WHERE id <> ALL($1::uuid[])", [clusters]);
  });
}
