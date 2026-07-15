import { useEffect, useState } from "react";
import { FileText, Inbox, Radio } from "lucide-react";

import { listEvents, listSnapshots } from "@/api/client";
import type { IacType, IngestionEvent, SnapshotSummary } from "@/api/types";
import { branchName, formatDate, shortSha } from "@/lib/format";

/** Which producer documents this repository's default branch (GP-102). */
function docsSource(iacType: IacType): "hcl" | "k8s_manifest" {
  return iacType === "kubernetes" ? "k8s_manifest" : "hcl";
}

type State =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      lastEvent: IngestionEvent | null;
      lastDocs: SnapshotSummary | null;
    };

/**
 * "Did my CI actually reach Groundplan?" (GP-111) — the setup page's answer, from
 * existing data only: the last CI webhook received (branch, sha, when) and the
 * last documentation snapshot generated. A plain fetch on mount, no polling.
 *
 * Its empty state is the whole point for a fresh repository: it names the thing
 * that hasn't happened yet and points back at the snippet above.
 */
export function IngestionStatus({
  repositoryId,
  iacType,
}: Readonly<{ repositoryId: string; iacType: IacType }>) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let active = true;
    Promise.all([
      listEvents(repositoryId),
      listSnapshots(repositoryId, { source: docsSource(iacType) }),
    ])
      .then(([events, snaps]) => {
        if (active) {
          setState({
            status: "ready",
            lastEvent: events[0] ?? null,
            lastDocs: snaps[0] ?? null,
          });
        }
      })
      .catch(() => {
        if (active) setState({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [repositoryId, iacType]);

  return (
    <section
      aria-label="Ingestion status"
      className="bg-muted/40 space-y-2 rounded-md border border-border p-3"
    >
      <p className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">
        Ingestion status
      </p>
      <Body state={state} />
    </section>
  );
}

function Body({ state }: Readonly<{ state: State }>) {
  if (state.status === "loading") {
    return <p className="text-muted-foreground text-xs">Checking…</p>;
  }
  if (state.status === "error") {
    return (
      <p className="text-muted-foreground text-xs">
        Couldn&apos;t load ingestion status.
      </p>
    );
  }

  if (!state.lastEvent) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <Inbox className="size-3.5 shrink-0" />
        No plan received yet — run the snippet above in your CI.
      </p>
    );
  }

  const { lastEvent, lastDocs } = state;
  return (
    <dl className="space-y-2 text-xs">
      <Row icon={<Radio className="size-3.5 shrink-0" />} label="Last plan received">
        <span className="font-mono">{branchName(lastEvent.ref)}</span>
        <span className="text-muted-foreground">@</span>
        <span className="font-mono">{shortSha(lastEvent.commitSha)}</span>
        <span className="text-muted-foreground">· {formatDate(lastEvent.receivedAt)}</span>
      </Row>
      <Row
        icon={<FileText className="size-3.5 shrink-0" />}
        label="Last docs snapshot"
      >
        {lastDocs ? (
          <span className="font-mono">{formatDate(lastDocs.createdAt)}</span>
        ) : (
          <span className="text-muted-foreground">never generated yet</span>
        )}
      </Row>
    </dl>
  );
}

function Row({
  icon,
  label,
  children,
}: Readonly<{ icon: React.ReactNode; label: string; children: React.ReactNode }>) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <dt className="text-muted-foreground flex items-center gap-1.5">
        {icon}
        {label}
      </dt>
      <dd className="text-foreground flex flex-wrap items-center gap-1.5">
        {children}
      </dd>
    </div>
  );
}
