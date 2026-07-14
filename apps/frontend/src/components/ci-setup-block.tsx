import { useState } from "react";

import type { IacType } from "@/api/types";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

/** A ready-to-paste GitHub Actions workflow that feeds plan.json to Groundplan. */
export function ciWorkflowSnippet(webhookUrl: string): string {
  return `name: Groundplan
on:
  pull_request:
  push:
    branches: [main]
jobs:
  # On a pull request: send the plan so Groundplan can draw the impact diagram.
  plan:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
      - run: terraform init
      - run: terraform plan -out=tfplan
      - run: terraform show -json tfplan > plan.json
      - name: Send plan to Groundplan
        run: |
          curl -sf -X POST "${webhookUrl}" \\
            -H "X-Groundplan-Token: \${{ secrets.GROUNDPLAN_WEBHOOK_TOKEN }}" \\
            -H "Content-Type: application/json" \\
            -d "$(jq -n \\
              --arg ref "$GITHUB_REF" \\
              --arg sha "$GITHUB_SHA" \\
              --argjson pr \${{ github.event.pull_request.number }} \\
              --slurpfile plan plan.json \\
              '{ref:$ref, commit_sha:$sha, event:"pull_request", pr_number:$pr, payload:$plan[0]}')"
  # On a merge to main: refresh the living documentation of the default branch.
  docs:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - name: Refresh Groundplan documentation
        run: |
          curl -sf -X POST "${webhookUrl}" \\
            -H "X-Groundplan-Token: \${{ secrets.GROUNDPLAN_WEBHOOK_TOKEN }}" \\
            -H "Content-Type: application/json" \\
            -d "$(jq -n --arg ref "$GITHUB_REF" --arg sha "$GITHUB_SHA" \\
              '{ref:$ref, commit_sha:$sha, event:"push", payload:{}}')"
`;
}

/**
 * How a repository's manifests become YAML (GP-104). Three flavours, one shape:
 * **render, then post**. Groundplan never runs `helm` or `kustomize` — they are Go
 * binaries, and running somebody's chart in our backend is exactly the access we
 * promise not to take. Your CI renders; we ingest the result, the same way we
 * ingest a plan.json instead of running `terraform`.
 */
export type ManifestFlavour = "raw" | "helm" | "kustomize";

export const MANIFEST_FLAVOURS: { id: ManifestFlavour; label: string }[] = [
  { id: "raw", label: "Raw YAML" },
  { id: "helm", label: "Helm" },
  { id: "kustomize", label: "Kustomize" },
];

/** The one line that differs between the flavours: how the YAML is produced. */
const RENDER_STEP: Record<ManifestFlavour, string> = {
  raw: "cat manifests/*.yaml > rendered.yaml",
  helm: "helm template . -f values.yaml > rendered.yaml",
  kustomize: "kustomize build overlays/prod > rendered.yaml",
};

/**
 * Only a raw-YAML repository can be documented from its own files: a chart's
 * templates are Go source, not manifests, so main's diagram has to come from the
 * same render its pull requests do (GP-102 skips what it cannot parse).
 */
export function docsFromCi(flavour: ManifestFlavour): boolean {
  return flavour !== "raw";
}

/** A ready-to-paste GitHub Actions workflow that feeds rendered manifests to us. */
export function manifestWorkflowSnippet(
  webhookUrl: string,
  flavour: ManifestFlavour,
): string {
  const render = RENDER_STEP[flavour];
  const docsJob = docsFromCi(flavour)
    ? `  # On a merge to main: render main and send it — templates aren't manifests,
  # so this render is the only thing Groundplan can document the branch from.
  docs:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ${render}
      - name: Send main's manifests to Groundplan
        run: |
          curl -sf -X POST "${webhookUrl}" \\
            -H "X-Groundplan-Token: \${{ secrets.GROUNDPLAN_WEBHOOK_TOKEN }}" \\
            -H "Content-Type: application/json" \\
            -d "$(jq -n \\
              --arg ref "$GITHUB_REF" \\
              --arg sha "$GITHUB_SHA" \\
              --arg manifests "$(cat rendered.yaml)" \\
              '{ref:$ref, commit_sha:$sha, event:"push", payload:{manifests:$manifests}}')"
`
    : `  # On a merge to main: Groundplan re-reads the manifests itself, so this
  # only needs to tell it that main moved.
  docs:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - name: Refresh Groundplan documentation
        run: |
          curl -sf -X POST "${webhookUrl}" \\
            -H "X-Groundplan-Token: \${{ secrets.GROUNDPLAN_WEBHOOK_TOKEN }}" \\
            -H "Content-Type: application/json" \\
            -d "$(jq -n --arg ref "$GITHUB_REF" --arg sha "$GITHUB_SHA" \\
              '{ref:$ref, commit_sha:$sha, event:"push", payload:{}}')"
`;

  return `name: Groundplan
on:
  pull_request:
  push:
    branches: [main]
jobs:
  # On a pull request: render the head and send it, so Groundplan can colour the
  # diagram against main.
  manifests:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ${render}
      - name: Send rendered manifests to Groundplan
        run: |
          curl -sf -X POST "${webhookUrl}" \\
            -H "X-Groundplan-Token: \${{ secrets.GROUNDPLAN_WEBHOOK_TOKEN }}" \\
            -H "Content-Type: application/json" \\
            -d "$(jq -n \\
              --arg ref "$GITHUB_REF" \\
              --arg sha "$GITHUB_SHA" \\
              --argjson pr \${{ github.event.pull_request.number }} \\
              --arg manifests "$(cat rendered.yaml)" \\
              '{ref:$ref, commit_sha:$sha, event:"pull_request", pr_number:$pr, payload:{manifests:$manifests}}')"
${docsJob}`;
}

function Field({
  label,
  value,
  mono = true,
  copyLabel,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyLabel: string;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">
        {label}
      </p>
      <div className="flex items-center gap-2">
        <code
          className={`bg-muted min-w-0 flex-1 truncate rounded-sm border border-border px-2.5 py-1.5 text-xs ${
            mono ? "font-mono" : ""
          }`}
        >
          {value}
        </code>
        <CopyButton value={value} label={copyLabel} />
      </div>
    </div>
  );
}

/**
 * CI wiring instructions for a repository: the webhook URL, the (once-shown)
 * token, and a copy-paste GitHub Actions workflow (GP-5 / GP-16).
 *
 * A kubernetes repository (GP-104) picks its flavour first, because the workflow
 * it needs depends on how its YAML is produced — and, for a chart or an overlay,
 * so does where its documentation comes from.
 */
export function CiSetupBlock({
  webhookUrl,
  webhookToken,
  iacType = "terraform",
}: {
  webhookUrl: string;
  webhookToken?: string;
  iacType?: IacType;
}) {
  const [flavour, setFlavour] = useState<ManifestFlavour>("raw");
  const kubernetes = iacType === "kubernetes";
  const snippet = kubernetes
    ? manifestWorkflowSnippet(webhookUrl, flavour)
    : ciWorkflowSnippet(webhookUrl);

  return (
    <div className="min-w-0 space-y-4">
      <Field label="Webhook URL" value={webhookUrl} copyLabel="Copy URL" />

      {webhookToken ? (
        <div className="space-y-1.5">
          <Field
            label="Webhook token — shown once"
            value={webhookToken}
            copyLabel="Copy token"
          />
          <p className="text-muted-foreground text-xs">
            Save this now as the repository secret{" "}
            <code className="font-mono">GROUNDPLAN_WEBHOOK_TOKEN</code> — it
            won&apos;t be shown again.
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          The webhook token was shown once when the repository was attached. Store
          it as the secret{" "}
          <code className="font-mono">GROUNDPLAN_WEBHOOK_TOKEN</code>.
        </p>
      )}

      {kubernetes && (
        <div className="space-y-1.5">
          <div role="group" aria-label="Manifest flavour" className="flex gap-1">
            {MANIFEST_FLAVOURS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={flavour === id}
                onClick={() => setFlavour(id)}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs transition-colors",
                  flavour === id
                    ? "border-primary bg-accent-soft text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">
            {docsFromCi(flavour)
              ? "Templates aren't manifests, so Groundplan can't read this repository's diagram from its files — main's documentation comes from your CI rendering it on merge, exactly as pull requests do."
              : "Groundplan reads these manifests from the repository itself, so merges to main re-document it without a render step."}
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">
            GitHub Actions workflow
          </p>
          <CopyButton value={snippet} label="Copy workflow" />
        </div>
        <pre className="bg-muted max-h-72 overflow-auto rounded-sm border border-border p-3 font-mono text-xs leading-relaxed">
          {snippet}
        </pre>
      </div>
    </div>
  );
}
