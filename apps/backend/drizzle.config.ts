import { defineConfig } from "drizzle-kit";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://groundplan:groundplan@localhost:5432/groundplan";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: DATABASE_URL },
});
