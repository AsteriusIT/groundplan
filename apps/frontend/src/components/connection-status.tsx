import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ConnectionStatus, VerifyErrorKind } from "@/api/types";

const STATUS = {
  ok: {
    label: "Connected",
    icon: CheckCircle2,
    className: "border-emerald-300 bg-emerald-50 text-emerald-700",
  },
  failed: {
    label: "Connection failed",
    icon: XCircle,
    className: "border-destructive/30 bg-destructive/5 text-destructive",
  },
  unverified: {
    label: "Not verified",
    icon: CircleDashed,
    className: "border-border bg-muted text-muted-foreground",
  },
} as const;

/** Small pill showing a repository's last connection-check result (GP-11). */
export function ConnectionStatusBadge({
  status,
}: {
  status: ConnectionStatus;
}) {
  const { label, icon: Icon, className } = STATUS[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-xs",
        className,
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </span>
  );
}

/** A human-readable, actionable message for a structured verify error. */
export function connectionErrorMessage(kind: VerifyErrorKind): string {
  switch (kind) {
    case "auth_failed":
      return "Authentication failed — check the access token has read access.";
    case "not_found":
      return "Repository not found — check the URL and default branch.";
    case "network":
      return "Could not reach the repository — check the URL is reachable.";
  }
}
