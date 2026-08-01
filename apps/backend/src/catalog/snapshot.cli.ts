/**
 * Build or read back a catalog snapshot (GP-239).
 *
 *   pnpm --filter @groundplan/backend catalog:snapshot --out catalog-snapshot.json.gz
 *   pnpm --filter @groundplan/backend catalog:snapshot --in  catalog-snapshot.json.gz
 *
 * Export reads what the connected instance is serving and writes it as one
 * deterministic artefact — the same catalog always produces the same bytes, so
 * a release can checksum it. Import seeds an empty catalog from one, which is
 * what an operator does when they take a snapshot into an air-gapped network by
 * hand rather than through the image.
 *
 * The release pipeline runs the export after the worker has done one pass; see
 * `.github/workflows/build-images.yml`.
 */
import "dotenv/config";

import { writeFile, readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { loadEnv } from "../config/env.js";
import { parseAllowlist, providerId } from "./providers.js";
import { catalogRepository } from "./repository.js";
import {
  exportSnapshot,
  importSnapshot,
  packSnapshot,
  unpackSnapshot,
} from "./snapshot.js";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const out = flag("--out");
const into = flag("--in");

if (!out && !into) {
  console.error("usage: catalog:snapshot --out <file> | --in <file>");
  process.exit(2);
}

const env = loadEnv();
const allowlist = parseAllowlist(env.catalogProviders);
const pool = new Pool({ connectionString: env.databaseUrl });
const repo = catalogRepository(drizzle(pool));

try {
  if (out) {
    const snapshot = await exportSnapshot(repo, allowlist);
    const missing = allowlist
      .map(providerId)
      .filter((id) => !snapshot.providers.some((p) => p.provider === id));
    await writeFile(out, packSnapshot(snapshot));
    console.log(
      `wrote ${out}: ${snapshot.providers
        .map((p) => `${p.provider}@${p.version} (${p.schemas.length} types)`)
        .join(", ")}`,
    );
    if (missing.length > 0) {
      // Named, never silent: a snapshot short of a provider is a release whose
      // air-gapped installs quietly lack it.
      console.warn(`WARNING: nothing ready for ${missing.join(", ")}`);
    }
  } else if (into) {
    const outcomes = await importSnapshot(await readFile(into).then(unpackSnapshot), {
      repo,
      allowlist,
    });
    for (const outcome of outcomes) {
      console.log(
        `${outcome.provider}@${outcome.version}: ${outcome.action} (${outcome.types} types)`,
      );
    }
  }
} finally {
  await pool.end();
}
