import fp from "fastify-plugin";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

declare module "fastify" {
  interface FastifyInstance {
    /** Raw node-postgres connection pool. */
    pool: Pool;
    /** Drizzle ORM instance bound to the pool. */
    db: NodePgDatabase;
  }
}

export type DbPluginOptions = {
  databaseUrl: string;
  /** Inject a pool (e.g. a stub in tests). Defaults to a real pool. */
  pool?: Pool;
};

/**
 * Decorates the app with a Postgres connection pool and a Drizzle instance,
 * and closes the pool on shutdown. The pool is lazy — it does not connect
 * until the first query.
 */
export const dbPlugin = fp<DbPluginOptions>(async (app, opts) => {
  const pool = opts.pool ?? new Pool({ connectionString: opts.databaseUrl });
  const db = drizzle(pool);

  app.decorate("pool", pool);
  app.decorate("db", db);

  app.addHook("onClose", async () => {
    await pool.end();
  });
});
