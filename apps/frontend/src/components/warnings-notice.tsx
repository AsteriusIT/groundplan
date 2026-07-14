import { useState } from "react";
import { TriangleAlert, X } from "lucide-react";

/**
 * What the producer could not do while building this snapshot: a file it could
 * not read (GP-15), a Terraform root that matched nothing, a Kubernetes kind RBAC
 * would not let it list (GP-97).
 *
 * A banner in the page flow, above the canvas — never a floating box in the
 * canvas's corner, where the filter panel paints over it and the one warning that
 * explains an empty diagram ends up hidden behind "0 of 0 shown".
 *
 * A partial diagram that says it is partial is worth having. One that quietly
 * looks complete is not.
 */
export function WarningsNotice({
  warnings,
  dismissible = false,
}: {
  warnings: string[];
  /** A live cluster read is repeated; its warnings should not be permanent. */
  dismissible?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (warnings.length === 0 || dismissed) return null;

  // One warning IS the message. Hiding it behind a "1 file skipped" summary made
  // the reader click to learn what happened — and lied when it wasn't a file.
  const only = warnings.length === 1 ? warnings[0] : null;

  return (
    <div
      role="status"
      className="border-warning/40 bg-warning-soft text-warning flex items-start gap-2 border-b px-4 py-2 text-xs"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      {only ? (
        <span className="min-w-0 flex-1 font-mono break-all">{only}</span>
      ) : (
        <div className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="underline underline-offset-2"
          >
            {warnings.length} warnings while building this snapshot
          </button>
          {expanded && (
            <ul className="mt-1 space-y-0.5 font-mono">
              {warnings.map((warning) => (
                <li key={warning} className="break-all">
                  {warning}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {dismissible && (
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss warnings"
          className="shrink-0 rounded-sm p-0.5 hover:opacity-70"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
