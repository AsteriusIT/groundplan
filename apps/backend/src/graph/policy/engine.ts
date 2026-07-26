/**
 * GP-200: the engine. It runs the catalogue over a graph and sorts what comes
 * back — that is the whole of it. It does not know what any rule looks at, which
 * is why adding a rule never touches this file.
 *
 * Determinism is the contract: the same graph and the same configuration
 * produce the same report, byte for byte, forever. So nothing here reads a
 * clock, a random number or the database; violations are sorted by a total order
 * (severity, then address, then rule, then message) and the effective
 * configuration travels inside the report rather than being looked up again
 * later.
 */
import type { Graph } from "../graph.js";
import { POLICY_CATALOG } from "./catalog.js";
import {
  SEVERITY_RANK,
  type EffectiveRule,
  type PolicyConfig,
  type PolicyCounts,
  type PolicyReport,
  type PolicyRule,
  type PolicySeverity,
  type PolicyStatus,
  type PolicyTarget,
  type PolicyViolation,
} from "./types.js";

export type EvaluateOptions = {
  /** Which kind of graph this is — a rule that cannot judge it is skipped. */
  target: PolicyTarget;
  /** The resolved configuration (catalogue ⊕ org ⊕ repository). */
  config?: PolicyConfig;
};

/** Fold a rule's catalogue defaults with the configuration written for it. */
export function effectiveRuleFor(
  rule: PolicyRule,
  target: PolicyTarget,
  config: PolicyConfig,
): EffectiveRule {
  const override = config[rule.id] ?? {};
  const params =
    rule.defaultParams === undefined
      ? undefined
      : { ...rule.defaultParams, ...(override.params ?? {}) };
  return {
    ruleId: rule.id,
    enabled: override.enabled ?? rule.defaultEnabled ?? true,
    severity: override.severity ?? rule.defaultSeverity,
    applicable: rule.appliesTo.includes(target),
    ...(params === undefined ? {} : { params }),
  };
}

/** Worst active violation wins; a waived one has been answered, so it does not. */
export function statusFrom(counts: PolicyCounts): PolicyStatus {
  if (counts.error > 0) return "failing";
  if (counts.warning > 0) return "warnings";
  return "passing";
}

function countOf(violations: PolicyViolation[]): PolicyCounts {
  const counts: PolicyCounts = {
    error: 0,
    warning: 0,
    info: 0,
    waived: 0,
    total: violations.length,
  };
  for (const violation of violations) {
    if (violation.waiver) counts.waived += 1;
    else counts[violation.severity] += 1;
  }
  return counts;
}

/** The total order a report's violations are listed in. */
function compareViolations(a: PolicyViolation, b: PolicyViolation): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.address.localeCompare(b.address) ||
    a.ruleId.localeCompare(b.ruleId) ||
    a.message.localeCompare(b.message)
  );
}

/**
 * Evaluate a graph against the catalogue. A disabled rule and a rule that cannot
 * judge this kind of graph are both simply not run — and both say so in
 * `report.rules`, because "not checked" and "passed" are different answers and
 * the report must not blur them.
 */
export function evaluatePolicy(
  graph: Graph,
  options: EvaluateOptions,
): PolicyReport {
  const config = options.config ?? {};
  const rules: EffectiveRule[] = [];
  const violations: PolicyViolation[] = [];

  for (const rule of POLICY_CATALOG) {
    const effective = effectiveRuleFor(rule, options.target, config);
    rules.push(effective);
    if (!effective.enabled || !effective.applicable) continue;
    for (const note of rule.evaluate({ graph, params: effective.params ?? {} })) {
      violations.push({
        ruleId: rule.id,
        severity: effective.severity,
        address: note.address,
        message: note.message,
        hint: note.hint,
      });
    }
  }

  violations.sort(compareViolations);
  rules.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  const counts = countOf(violations);

  return {
    version: 1,
    target: options.target,
    status: statusFrom(counts),
    counts,
    violations,
    rules,
  };
}

/**
 * The severity a set of violations amounts to, or null when there are none.
 * Used to grade a pull request on its *new* violations (GP-202).
 */
export function worstSeverity(
  violations: PolicyViolation[],
): PolicySeverity | null {
  let worst: PolicySeverity | null = null;
  for (const violation of violations) {
    if (violation.waiver) continue;
    if (worst === null || SEVERITY_RANK[violation.severity] < SEVERITY_RANK[worst]) {
      worst = violation.severity;
    }
  }
  return worst;
}
