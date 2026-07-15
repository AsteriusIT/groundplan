import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";

import { appSettings } from "../db/schema.js";
import { generateToken } from "../lib/tokens.js";

/**
 * The app-wide CI webhook token: a single global secret that authenticates a plan
 * push to *any* repository, alongside each repository's own token. It lives in the
 * `app_settings` singleton (see the schema for why it is plaintext, and why it is
 * global for now). These four functions are the only ones that touch it.
 */

// The singleton row's key — always `true` (the table's check enforces it).
const SINGLETON = true;

/** The app-wide webhook token, or null when none is set. */
export async function getAppWebhookToken(
  db: NodePgDatabase,
): Promise<string | null> {
  const [row] = await db
    .select({ token: appSettings.webhookToken })
    .from(appSettings)
    .where(eq(appSettings.id, SINGLETON));
  return row?.token ?? null;
}

/** Whether an app-wide token is set, and when it was last set (never the value). */
export async function getIngestionSettings(
  db: NodePgDatabase,
): Promise<{ appWebhookTokenSet: boolean; updatedAt: string | null }> {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.id, SINGLETON));
  return {
    appWebhookTokenSet: Boolean(row?.webhookToken),
    updatedAt: row?.webhookToken ? (row.webhookTokenSetAt?.toISOString() ?? null) : null,
  };
}

/** Generate (or rotate) the app-wide token; returns the new value, shown once. */
export async function rotateAppWebhookToken(db: NodePgDatabase): Promise<string> {
  const token = generateToken();
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ id: SINGLETON, webhookToken: token, webhookTokenSetAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { webhookToken: token, webhookTokenSetAt: now, updatedAt: now },
    });
  return token;
}

/** Revoke the app-wide token. Per-repository tokens keep working. */
export async function clearAppWebhookToken(db: NodePgDatabase): Promise<void> {
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ id: SINGLETON, webhookToken: null, webhookTokenSetAt: null, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { webhookToken: null, webhookTokenSetAt: null, updatedAt: now },
    });
}
