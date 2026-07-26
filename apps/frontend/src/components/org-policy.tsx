import { useCallback, useEffect, useState } from "react";

import { getOrgPolicyConfig, saveOrgPolicyConfig } from "@/api/client";
import type { OrgPolicyConfig, PolicyConfig } from "@/api/types";
import { PolicyRules } from "@/components/policy-rules";

/**
 * The organization's policy configuration (GP-201). Every member sees the
 * catalogue — being graded by a rule you cannot read is not a policy, it is a
 * surprise — and `policy:manage` (owner/admin) is what makes it editable, gated
 * inside `PolicyRules` and enforced by the API.
 */
export function OrgPolicy() {
  const [config, setConfig] = useState<OrgPolicyConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getOrgPolicyConfig()
      .then(setConfig)
      .catch(() => setError("Could not load the policy configuration."));
  }, []);
  useEffect(load, [load]);

  const save = useCallback(
    (rules: PolicyConfig) => saveOrgPolicyConfig(rules).then(setConfig),
    [],
  );

  if (error) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {error}
      </p>
    );
  }
  if (!config) {
    return <p className="text-muted-foreground text-sm">Loading rules…</p>;
  }

  return (
    <PolicyRules
      catalog={config.catalog}
      document={config.rules}
      onSave={save}
    />
  );
}
