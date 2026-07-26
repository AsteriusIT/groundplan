/**
 * GP-200: the built-in rule catalogue — the only place that knows which rules
 * exist, the same way `integrations/registry.ts` is the only place that knows
 * which providers exist.
 *
 * Two sources feed it. The studio's lint rules (GP-139) are wrapped, not copied:
 * they were already pure functions over a graph node, so a rule written for the
 * playground is enforced on a pull request without being written twice — and a
 * rule added there is added here. The rest live in `rules.ts`.
 *
 * v1 has no custom-rule DSL and does not pretend to: `PolicyRule` is the seam a
 * later one plugs into.
 */
import {
  LINT_RULES,
  type LintRuleDefinition,
  type LintSeverity,
} from "../hcl-lint.js";
import { GRAPH_RULES } from "./rules.js";
import type { PolicyRule, PolicySeverity } from "./types.js";

/**
 * The lint pass grades findings the way a linter does; a policy grades them the
 * way an organization does. Same judgement, different vocabulary.
 */
const SEVERITY_FROM_LINT: Record<LintSeverity, PolicySeverity> = {
  high: "error",
  warn: "warning",
  info: "info",
};

/** Wrap a studio lint rule as a policy rule. Terraform-only: every one of them
 * reads a Terraform resource type or its HCL. */
function fromLintRule(rule: LintRuleDefinition): PolicyRule {
  return {
    id: rule.ruleId,
    title: rule.title,
    description: rule.description,
    defaultSeverity: SEVERITY_FROM_LINT[rule.severity],
    appliesTo: ["terraform"],
    evaluate({ graph }) {
      return graph.nodes.flatMap((node) =>
        rule.run(node).map((note) => ({
          address: node.id,
          message: note.message,
          hint: note.fixHint,
        })),
      );
    },
  };
}

/**
 * Every built-in rule, in a fixed order. The order is the catalogue's, not the
 * report's — a report sorts its own violations (see `engine.ts`).
 */
export const POLICY_CATALOG: PolicyRule[] = [
  ...LINT_RULES.map(fromLintRule),
  ...GRAPH_RULES,
];

/** A rule by id, or undefined — configuration may name a rule we since removed. */
export function ruleById(id: string): PolicyRule | undefined {
  return POLICY_CATALOG.find((rule) => rule.id === id);
}
