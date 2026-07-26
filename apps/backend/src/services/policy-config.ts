/**
 * GP-201: resolving "which rules, how loudly" for one repository.
 *
 * Three layers, folded in one direction and one direction only:
 *
 *     catalogue defaults  →  the organization's document  →  the repository's
 *
 * The fold is per *field*, not per rule: a repository that only wants a
 * different severity does not have to restate `enabled`, and it inherits every
 * rule it says nothing about. Deleting a repository's document therefore returns
 * it to the organization's configuration exactly, with no reconstruction.
 *
 * The catalogue's own defaults are applied by the engine (`effectiveRuleFor`),
 * not here — so a rule added to the catalogue is live everywhere without a
 * backfill of anybody's configuration.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNull } from "drizzle-orm";

import {
  policyConfigs,
  projects,
  repositories,
  type PolicyConfigRow,
} from "../db/schema.js";
import { POLICY_CATALOG, ruleById } from "../graph/policy/catalog.js";
import { effectiveRuleFor } from "../graph/policy/engine.js";
import {
  POLICY_SEVERITIES,
  type EffectiveRule,
  type PolicyConfig,
  type PolicyRuleOverride,
  type PolicySeverity,
  type PolicyTarget,
} from "../graph/policy/types.js";

/**
 * Merge one configuration document over another, per rule and per field. Rules
 * the catalogue no longer knows are dropped here: configuration must never be
 * able to break an evaluation, and a stale key is not a reason to fail one.
 */
export function mergePolicyConfig(
  base: PolicyConfig,
  over: PolicyConfig,
): PolicyConfig {
  const merged: PolicyConfig = {};
  for (const id of new Set([...Object.keys(base), ...Object.keys(over)])) {
    if (!ruleById(id)) continue;
    const entry: PolicyRuleOverride = { ...base[id], ...over[id] };
    // Params merge per key too — a repository adding one required tag key does
    // not have to restate the org's list.
    const params = { ...(base[id]?.params ?? {}), ...(over[id]?.params ?? {}) };
    if (Object.keys(params).length > 0) entry.params = params;
    if (Object.keys(entry).length > 0) merged[id] = entry;
  }
  return merged;
}

/** The stored document for a scope, or null when the scope never wrote one. */
export async function loadPolicyConfigRow(
  db: NodePgDatabase,
  scope: { organizationId: string; repositoryId?: string | null },
): Promise<PolicyConfigRow | null> {
  const repositoryId = scope.repositoryId ?? null;
  const [row] = await db
    .select()
    .from(policyConfigs)
    .where(
      and(
        eq(policyConfigs.organizationId, scope.organizationId),
        repositoryId === null
          ? isNull(policyConfigs.repositoryId)
          : eq(policyConfigs.repositoryId, repositoryId),
      ),
    );
  return row ?? null;
}

/** The organization's own document (empty when it never configured anything). */
export async function orgPolicyConfig(
  db: NodePgDatabase,
  organizationId: string,
): Promise<PolicyConfig> {
  const row = await loadPolicyConfigRow(db, { organizationId });
  return row?.rules ?? {};
}

/** A repository's override, or null when it inherits the org's configuration. */
export async function repositoryPolicyOverride(
  db: NodePgDatabase,
  repositoryId: string,
): Promise<PolicyConfig | null> {
  const [row] = await db
    .select()
    .from(policyConfigs)
    .where(eq(policyConfigs.repositoryId, repositoryId));
  return row?.rules ?? null;
}

/**
 * The configuration a repository is actually evaluated under: the organization's
 * document with the repository's override folded over it.
 */
export async function resolvePolicyConfig(
  db: NodePgDatabase,
  repositoryId: string,
): Promise<PolicyConfig> {
  const [owner] = await db
    .select({ organizationId: projects.organizationId })
    .from(repositories)
    .innerJoin(projects, eq(repositories.projectId, projects.id))
    .where(eq(repositories.id, repositoryId));
  if (!owner) return {};

  const [org, override] = await Promise.all([
    orgPolicyConfig(db, owner.organizationId),
    repositoryPolicyOverride(db, repositoryId),
  ]);
  return override ? mergePolicyConfig(org, override) : org;
}

/** Write a scope's document, replacing it wholesale (a configuration is one thing). */
export async function savePolicyConfig(
  db: NodePgDatabase,
  scope: { organizationId: string; repositoryId?: string | null },
  rules: PolicyConfig,
  updatedBy: string | null,
): Promise<PolicyConfigRow> {
  const repositoryId = scope.repositoryId ?? null;
  const existing = await loadPolicyConfigRow(db, scope);
  if (existing) {
    const [row] = await db
      .update(policyConfigs)
      .set({ rules, updatedBy, updatedAt: new Date() })
      .where(eq(policyConfigs.id, existing.id))
      .returning();
    return row as PolicyConfigRow;
  }
  const [row] = await db
    .insert(policyConfigs)
    .values({
      organizationId: scope.organizationId,
      repositoryId,
      rules,
      updatedBy,
    })
    .returning();
  return row as PolicyConfigRow;
}

/** Drop a repository's override — it goes back to the organization's config. */
export async function deleteRepositoryPolicyConfig(
  db: NodePgDatabase,
  repositoryId: string,
): Promise<void> {
  await db.delete(policyConfigs).where(eq(policyConfigs.repositoryId, repositoryId));
}

/**
 * The catalogue as the settings UI needs it: every rule, its metadata, and the
 * configuration it would run under in this scope. `configured` says whether the
 * scope itself has an opinion — which is what makes an inherited value and an
 * override that happens to match distinguishable on screen.
 */
export type PolicyCatalogEntry = EffectiveRule & {
  title: string;
  description: string;
  defaultSeverity: PolicySeverity;
  defaultEnabled: boolean;
  appliesTo: PolicyTarget[];
  /** True when *this* scope's document names the rule. */
  configured: boolean;
};

export function catalogWithConfig(
  config: PolicyConfig,
  scopeDocument: PolicyConfig,
  target: PolicyTarget = "terraform",
): PolicyCatalogEntry[] {
  return POLICY_CATALOG.map((rule) => ({
    ...effectiveRuleFor(rule, target, config),
    title: rule.title,
    description: rule.description,
    defaultSeverity: rule.defaultSeverity,
    defaultEnabled: rule.defaultEnabled ?? true,
    appliesTo: [...rule.appliesTo],
    configured: scopeDocument[rule.id] !== undefined,
  }));
}

/**
 * Validate a configuration document sent by a client. The route schema already
 * enforces the shape; this enforces the *meaning* — an unknown rule id is a
 * mistake worth naming rather than a key to silently drop, because a typo that
 * disappears looks exactly like a setting that did not save.
 */
export function validatePolicyConfig(rules: PolicyConfig): string | null {
  for (const [id, override] of Object.entries(rules)) {
    if (!ruleById(id)) return `unknown policy rule: ${id}`;
    if (
      override.severity !== undefined &&
      !POLICY_SEVERITIES.includes(override.severity)
    ) {
      return `unknown severity for ${id}: ${String(override.severity)}`;
    }
  }
  return null;
}
