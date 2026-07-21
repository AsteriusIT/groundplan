import { CheckCircle2, CircleDashed, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  ConfluenceErrorKind,
  ConnectionStatus,
  K8sErrorKind,
  VerifyErrorKind,
} from "@/api/types";

const STATUS = {
  ok: {
    label: "Connected",
    icon: CheckCircle2,
    // Solid green fill (semantic `create` token) with white text — the same
    // filled-status treatment the node StatusBadge uses. A confident "yes":
    // it reads at a glance where the old pale-mint pill did not. Failed /
    // unverified deliberately stay quiet, so success is the only badge that pops.
    className: "border-create bg-create text-white",
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

const DOT = {
  ok: "bg-create",
  failed: "bg-delete",
  unverified: "bg-muted-foreground/40",
} as const;

/**
 * A repository's connection status as a dot beside its name (GP-11). Status is
 * metadata, not an action: it reads as part of the identity of the row instead
 * of competing with the buttons. The label stays available to screen readers
 * and on hover — the colour alone is never the message.
 */
export function ConnectionStatusDot({
  status,
}: Readonly<{ status: ConnectionStatus }>) {
  const { label } = STATUS[status];
  return (
    <span
      className="inline-flex shrink-0 items-center"
      title={label}
      aria-label={label}
      role="img"
    >
      <span className={cn("size-2 rounded-full", DOT[status])} />
    </span>
  );
}

/** Small pill showing a repository's last connection-check result (GP-11). */
export function ConnectionStatusBadge({
  status,
}: Readonly<{
  status: ConnectionStatus;
}>) {
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

/**
 * The same, for a cluster (GP-95/GP-98). A separate function rather than a
 * cleverly parameterised one: every message here names the thing the reader must
 * go and fix, and "the repository" is never the right noun for a cluster.
 */
export function clusterErrorMessage(kind: K8sErrorKind): string {
  switch (kind) {
    case "auth_failed":
      return "The cluster rejected the credentials — check the kubeconfig's user has read access.";
    case "not_found":
      return "The cluster's API server answered, but not to us — check the server URL in the kubeconfig.";
    case "network":
      return "Could not reach the cluster — check the API server is reachable from Groundplan.";
    case "invalid_config":
      return "The kubeconfig could not be read — check it is complete and has a current context.";
  }
}

/** The same, for a Confluence connection or publish (GP-179/GP-180). */
export function confluenceErrorMessage(kind: ConfluenceErrorKind): string {
  switch (kind) {
    case "auth_failed":
      return "Confluence rejected the credential — check the token (and, on a Cloud site, the account email).";
    case "space_not_found":
      return "The space was not found — check the space key exists on that site.";
    case "network":
      return "Could not reach the Confluence site — check the base URL.";
  }
}
