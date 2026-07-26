import { Link } from "react-router-dom";

import { OrgPolicy } from "@/components/org-policy";
import { PageHeader } from "@/components/page-header";
import { useOrg } from "@/org/use-org";

/**
 * Policies — a place of its own, not a section of organization settings.
 *
 * Settings is where you configure the workspace: who is in it, what it connects
 * to, which token CI uses. The policy catalogue is not that. It is the standard
 * every pull request is graded against and every diagram of main is measured by,
 * it is read by people who will never open Settings, and it is where somebody
 * goes to answer "why is this repository failing?" — a question you do not
 * expect to answer from a settings page.
 *
 * The page is deliberately the *rules*, not the verdicts: where each repository
 * currently stands is on the dashboard (GP-203), beside the rest of the estate's
 * state, and duplicating it here would give compliance two homes and let them
 * disagree.
 */
export function PoliciesPage() {
  const { activeOrg } = useOrg();

  return (
    <div>
      <PageHeader
        eyebrow="Organization"
        title="Policies"
        description={
          activeOrg
            ? `The rules every pull request and every diagram of main is checked against in ${activeOrg.name}.`
            : "The rules every pull request and every diagram of main is checked against."
        }
      />
      <div className="mx-auto max-w-5xl px-8 py-8">
        <section className="bg-card rounded-md border border-border">
          <header className="border-b border-border px-5 py-3.5">
            <h2 className="font-display text-sm font-semibold tracking-tight">
              Rule catalogue
            </h2>
            <p className="text-muted-foreground mt-1 text-xs">
              Built-in rules, evaluated on the graph — deterministic, no AI and
              no cloud access. A repository can override any of them from its own
              Policy dialog.
            </p>
          </header>
          <div className="px-5 py-4">
            <OrgPolicy />
          </div>
        </section>

        <p className="text-muted-foreground mt-4 text-xs">
          Where each repository currently stands is on the{" "}
          <Link to="/dashboard" className="text-primary hover:underline">
            dashboard
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
