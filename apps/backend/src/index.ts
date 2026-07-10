import "dotenv/config";

import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);

  try {
    await app.listen({ host: env.host, port: env.port });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
