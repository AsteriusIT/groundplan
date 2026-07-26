import { useCallback, useEffect, useState } from "react";

import {
  deleteRepositoryPolicyConfig,
  getRepositoryPolicyConfig,
  saveRepositoryPolicyConfig,
} from "@/api/client";
import type { PolicyConfig, Repository, RepositoryPolicyConfig } from "@/api/types";
import { PolicyRules } from "@/components/policy-rules";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCan } from "@/rbac/use-can";

/**
 * This repository's policy override (GP-201). It opens on the organization's
 * configuration — inherited, and said so in as many words — and every rule this
 * repository changes is marked as changed. There is no third state: a rule is
 * either inherited or overridden here, and "Use the organization's policy"
 * removes the override wholesale rather than un-setting rules one by one.
 */
export function RepositoryPolicyDialog({
  repository,
  open,
  onOpenChange,
}: Readonly<{
  repository: Repository;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>) {
  const canManage = useCan("policy:manage");
  const [config, setConfig] = useState<RepositoryPolicyConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getRepositoryPolicyConfig(repository.id)
      .then(setConfig)
      .catch(() => setError("Could not load the policy configuration."));
  }, [repository.id]);

  // Read on opening, not on mount: this dialog lives behind a menu on every
  // repository row, and a project page should not fetch a configuration per row.
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const save = useCallback(
    (rules: PolicyConfig) =>
      saveRepositoryPolicyConfig(repository.id, rules).then(setConfig),
    [repository.id],
  );

  async function handleReset() {
    await deleteRepositoryPolicyConfig(repository.id);
    load();
  }

  const overriding = config?.override !== null && config?.override !== undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display">Policy for this repository</DialogTitle>
          <DialogDescription>
            What this repository is checked against. It inherits the
            organization's policy until you change a rule here.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
        {!config && !error && (
          <p className="text-muted-foreground text-sm">Loading rules…</p>
        )}

        {config && (
          <PolicyRules
            catalog={config.catalog}
            document={config.override ?? {}}
            onSave={save}
            notice={
              <p className="border-border bg-accent-soft text-muted-foreground rounded-md border px-3 py-2 text-xs">
                {overriding
                  ? "This repository overrides the organization's policy. Rules it does not change stay inherited."
                  : "Inherited from the organization. Changing a rule here creates an override for this repository only."}
              </p>
            }
            extraAction={
              overriding && canManage ? (
                <Button type="button" variant="outline" onClick={handleReset}>
                  Use the organization's policy
                </Button>
              ) : undefined
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
