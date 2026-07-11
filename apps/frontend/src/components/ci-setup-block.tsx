import { CopyButton } from "@/components/copy-button";

/** A ready-to-paste GitHub Actions workflow that feeds plan.json to Groundplan. */
export function ciWorkflowSnippet(webhookUrl: string): string {
  return `name: Groundplan
on: pull_request
jobs:
  plan:
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
`;
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
 */
export function CiSetupBlock({
  webhookUrl,
  webhookToken,
}: {
  webhookUrl: string;
  webhookToken?: string;
}) {
  const snippet = ciWorkflowSnippet(webhookUrl);
  return (
    <div className="min-w-0 space-y-4">
      <Field
        label="Webhook URL"
        value={webhookUrl}
        copyLabel="Copy URL"
      />

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
