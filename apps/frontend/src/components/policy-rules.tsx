import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw, ShieldCheck } from "lucide-react";

import type {
  PolicyCatalogEntry,
  PolicyConfig,
  PolicyRuleOverride,
  PolicySeverity,
} from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useCan } from "@/rbac/use-can";

/**
 * The rule catalogue as a settings control (GP-201): every built-in rule, what
 * it looks for, whether it is on, how loudly it speaks, and — for the rules that
 * take them — its parameters.
 *
 * The whole catalogue always renders, including the rules that are off and the
 * ones that cannot judge this repository's kind of graph. A rule you are graded
 * against must be visible, and so must a rule that is *not* grading you: a list
 * that hides what it does not run is a list that reads as a clean bill of health.
 *
 * Editing is optimistic-free on purpose — changes are held locally and written
 * on Save, because re-judging every repository's documentation on each keystroke
 * is not a thing to do to an estate.
 */

const SEVERITIES: PolicySeverity[] = ["error", "warning", "info"];

/** Severity → the status hue the rest of the product already uses for it. */
const SEVERITY_CLASS: Record<PolicySeverity, string> = {
  error: "bg-delete-soft text-delete border-delete/30",
  warning: "bg-update-soft text-update border-update/30",
  info: "bg-impacted-soft text-impacted border-impacted/30",
};

export type PolicyRulesProps = Readonly<{
  catalog: PolicyCatalogEntry[];
  /** This scope's own document — what Save will replace. */
  document: PolicyConfig;
  onSave: (rules: PolicyConfig) => Promise<unknown>;
  /** Rendered above the list (the repository scope explains inheritance there). */
  notice?: React.ReactNode;
  /** Shown beside Save; the repository scope uses it to drop its override. */
  extraAction?: React.ReactNode;
}>;

export function PolicyRules({
  catalog,
  document,
  onSave,
  notice,
  extraAction,
}: PolicyRulesProps) {
  const canManage = useCan("policy:manage");
  const [draft, setDraft] = useState<PolicyConfig>(document);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh document from the server (a save, a scope switch) replaces the draft:
  // what is on screen is always something that exists somewhere, never a merge.
  useEffect(() => setDraft(document), [document]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(document),
    [draft, document],
  );

  /** The value a rule currently shows: this scope's edit, else what it resolves to. */
  const shown = useCallback(
    (rule: PolicyCatalogEntry): { enabled: boolean; severity: PolicySeverity } => {
      const edit = draft[rule.ruleId];
      return {
        enabled: edit?.enabled ?? rule.enabled,
        severity: edit?.severity ?? rule.severity,
      };
    },
    [draft],
  );

  const setOverride = useCallback(
    (ruleId: string, patch: PolicyRuleOverride) => {
      setDraft((prev) => {
        const next = { ...prev, [ruleId]: { ...prev[ruleId], ...patch } };
        if (Object.keys(next[ruleId]!).length === 0) delete next[ruleId];
        return next;
      });
    },
    [],
  );

  const clearRule = useCallback((ruleId: string) => {
    setDraft((prev) => {
      const next = { ...prev };
      delete next[ruleId];
      return next;
    });
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch {
      setError("Could not save the policy configuration.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {notice}

      <ul className="divide-border divide-y">
        {catalog.map((rule) => {
          const value = shown(rule);
          const params = paramKeys(rule);
          return (
            <li key={rule.ruleId} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {rule.title}
                    <code className="text-faint font-mono text-[10px]">
                      {rule.ruleId}
                    </code>
                    {draft[rule.ruleId] && (
                      <span className="bg-accent-soft text-primary border-primary/30 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-none">
                        overridden
                      </span>
                    )}
                    {!rule.applicable && (
                      <span className="bg-muted text-muted-foreground border-border rounded-full border px-2 py-0.5 font-mono text-[10px] leading-none">
                        not applicable here
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {rule.description}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <fieldset
                    aria-label={`Severity of ${rule.title}`}
                    className="border-border bg-background flex items-center gap-0.5 rounded-lg border p-0.5"
                  >
                    {SEVERITIES.map((severity) => (
                      <button
                        key={severity}
                        type="button"
                        disabled={!canManage || !value.enabled}
                        aria-pressed={value.severity === severity}
                        onClick={() => setOverride(rule.ruleId, { severity })}
                        className={cn(
                          "rounded-md border border-transparent px-2 py-0.5 font-mono text-[11px] transition-colors",
                          value.severity === severity
                            ? SEVERITY_CLASS[severity]
                            : "text-muted-foreground hover:text-foreground",
                          (!canManage || !value.enabled) && "opacity-50",
                        )}
                      >
                        {severity}
                      </button>
                    ))}
                  </fieldset>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={value.enabled}
                    aria-label={`Enable ${rule.title}`}
                    disabled={!canManage}
                    onClick={() =>
                      setOverride(rule.ruleId, { enabled: !value.enabled })
                    }
                    className={cn(
                      "border-border relative h-5 w-9 shrink-0 rounded-full border transition-colors",
                      value.enabled ? "bg-create" : "bg-muted",
                      !canManage && "opacity-50",
                    )}
                  >
                    <span
                      className={cn(
                        "bg-card absolute top-0.5 size-3.5 rounded-full transition-all",
                        value.enabled ? "left-4.5" : "left-0.5",
                      )}
                    />
                  </button>

                  {draft[rule.ruleId] && canManage && (
                    <button
                      type="button"
                      aria-label={`Reset ${rule.title}`}
                      title="Reset to the inherited value"
                      onClick={() => clearRule(rule.ruleId)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <RotateCcw className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Parameters: only the rules that take them, and only string
                  lists — v1 has no rule DSL, and this is not the way in. */}
              {params.length > 0 && value.enabled && (
                <div className="mt-2 space-y-2">
                  {params.map((key) => (
                    <label key={key} className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground font-mono">{key}</span>
                      <Input
                        value={listValue(rule, draft, key)}
                        disabled={!canManage}
                        placeholder="comma-separated"
                        className="h-7 max-w-xs text-xs"
                        onChange={(e) =>
                          setOverride(rule.ruleId, {
                            params: {
                              ...(draft[rule.ruleId]?.params ?? rule.params ?? {}),
                              [key]: parseList(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}

      {canManage && (
        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={!dirty || saving}>
            <ShieldCheck className="size-4" />
            {saving ? "Saving…" : "Save policy"}
          </Button>
          {extraAction}
          {dirty && (
            <span className="text-muted-foreground text-xs">
              Saving re-checks the documentation of main.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** The parameter keys a rule takes that this control knows how to edit. */
function paramKeys(rule: PolicyCatalogEntry): string[] {
  if (!rule.params) return [];
  return Object.entries(rule.params)
    .filter(([, value]) => Array.isArray(value))
    .map(([key]) => key);
}

function listValue(
  rule: PolicyCatalogEntry,
  draft: PolicyConfig,
  key: string,
): string {
  const source = draft[rule.ruleId]?.params ?? rule.params ?? {};
  const value = source[key] ?? [];
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
