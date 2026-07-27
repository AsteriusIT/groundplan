import { CloudOff, FileQuestion, GitCompare, Scale, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { Reconciliation } from "@/api/types";
import { relativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/**
 * The reality rail (GP-209): the cloud, compared with the code.
 *
 * The vocabulary is the whole design. Underneath, this is the same graph-vs-graph
 * comparison a Kubernetes pull request uses, and the canvas colours it with the
 * same create/update/delete hues — but *nothing here is proposed*. So every word
 * a human reads is a reconciliation word: **not managed by this repository**,
 * **declared but not found**, **disagreeing**. Never "will be created", never
 * "destroy". A reader who takes this for a plan would go looking for the pull
 * request that caused it, and there isn't one.
 *
 * The freshness banner is not optional furniture either. The right-hand side of
 * this comparison is exactly as old as the last `push-state`, and a diagram that
 * does not say so will be read as live.
 */
export function RealityPanel({
  result,
  onSelectAddress,
  onClose,
}: Readonly<{
  result: Reconciliation;
  onSelectAddress: (address: string) => void;
  onClose: () => void;
}>) {
  const { counts } = result;
  const findings = counts.unmanaged + counts.notApplied + counts.divergent;

  return (
    <aside className="border-border bg-card flex w-80 shrink-0 flex-col overflow-y-auto border-l">
      <header className="border-border flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Scale className="text-muted-foreground size-4" />
          <h2 className="font-display text-sm font-semibold">Reality vs code</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close reality panel"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="space-y-4 px-4 py-4">
        <output className="text-muted-foreground border-border block rounded-md border px-3 py-2 text-xs">
          Comparing <code className="font-mono">{result.code.ref}</code> at{" "}
          <code className="font-mono">{short(result.code.commitSha)}</code> with the
          state read {relativeTime(result.reality.observedAt)}
          {result.reality.terraformVersion
            ? ` by Terraform ${result.reality.terraformVersion}`
            : ""}
          . Neither side is being watched — both are snapshots.
        </output>

        {findings === 0 ? (
          <p className="text-muted-foreground text-xs">
            The cloud matches the code: all {counts.matching} resources accounted
            for on both sides.
          </p>
        ) : (
          <p className="text-muted-foreground text-xs">
            {counts.matching} resource{counts.matching === 1 ? "" : "s"} accounted
            for on both sides.
          </p>
        )}

        <Section
          icon={CloudOff}
          title="Not managed by this repository"
          note="These exist in the cloud and nothing here describes them. Nobody reviewed them, and destroying this workspace would leave them behind."
          addresses={result.unmanaged}
          tone="unmanaged"
          onSelectAddress={onSelectAddress}
        />
        <Section
          icon={FileQuestion}
          title="Declared but not found"
          note="The code describes these and the state does not have them — never applied, or removed underneath it."
          addresses={result.notApplied}
          tone="missing"
          onSelectAddress={onSelectAddress}
        />
        <Section
          icon={GitCompare}
          title="Disagreeing"
          note="Present on both sides, with an attribute the two record differently."
          addresses={result.divergent}
          tone="divergent"
          onSelectAddress={onSelectAddress}
        />
      </div>
    </aside>
  );
}

/**
 * Each finding's hue. Reusing the diff tokens is deliberate — they are what the
 * canvas already colours these nodes with, and a rail that disagreed with the
 * diagram beside it would be worse than one that shares its palette. The words
 * carry the meaning; the colour only has to match.
 */
const TONE: Record<string, string> = {
  unmanaged: "border-create/40",
  missing: "border-delete/40",
  divergent: "border-update/40",
};

const ICON_TONE: Record<string, string> = {
  unmanaged: "text-create",
  missing: "text-delete",
  divergent: "text-update",
};

function Section({
  icon: Icon,
  title,
  note,
  addresses,
  tone,
  onSelectAddress,
}: Readonly<{
  icon: LucideIcon;
  title: string;
  note: string;
  addresses: string[];
  tone: keyof typeof TONE;
  onSelectAddress: (address: string) => void;
}>) {
  // A heading over an empty list reads as a finding nobody has expanded yet.
  if (addresses.length === 0) return null;
  return (
    <section>
      <h3 className="text-muted-foreground flex items-center gap-1.5 font-mono text-[11px] tracking-[0.14em] uppercase">
        <Icon className={cn("size-3.5", ICON_TONE[tone])} />
        {title} · {addresses.length}
      </h3>
      <p className="text-muted-foreground mt-1.5 text-xs">{note}</p>
      <ul className="mt-2 space-y-1.5">
        {addresses.map((address) => (
          <li key={address}>
            <button
              type="button"
              onClick={() => onSelectAddress(address)}
              className={cn(
                "hover:bg-accent block w-full rounded-md border px-2.5 py-1.5 text-left font-mono text-[11px] break-all transition-colors",
                TONE[tone],
              )}
            >
              {address}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const short = (sha: string): string => sha.slice(0, 7);
