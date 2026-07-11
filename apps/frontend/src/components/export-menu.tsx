/**
 * Export button for a snapshot (GP-37): downloads the server-rendered SVG or
 * PNG. The export endpoints require auth, so we fetch the image as a Blob
 * through the API client (bearer token attached) and hand it to the browser as
 * a download rather than pointing an <img>/<a> straight at the URL.
 */
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

import { ApiError, getSnapshotExport, type ExportFormat, type ExportScope } from "@/api/client";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

type Choice = { format: ExportFormat; scope: ExportScope; label: string };

export function ExportMenu({
  snapshotId,
  filenameBase,
  includeChangesScope = false,
}: {
  snapshotId: string;
  /** Base name for the downloaded file, e.g. `infra-2c9f8061`. */
  filenameBase: string;
  /** Offer a "changes only" variant (PR view). */
  includeChangesScope?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choices: Choice[] = [
    { format: "svg", scope: "full", label: "SVG" },
    { format: "png", scope: "full", label: "PNG" },
    ...(includeChangesScope
      ? ([{ format: "png", scope: "changes", label: "PNG (changes only)" }] as Choice[])
      : []),
  ];

  const download = async (choice: Choice) => {
    setBusy(true);
    setError(null);
    try {
      const blob = await getSnapshotExport(snapshotId, choice.format, choice.scope);
      const url = URL.createObjectURL(blob);
      const suffix = choice.scope === "changes" ? "-changes" : "";
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filenameBase}${suffix}.${choice.format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="group relative">
      <summary
        className={cn(
          buttonVariants({ variant: "outline" }),
          "cursor-pointer list-none marker:hidden",
        )}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        Export
      </summary>
      <div
        className={cn(
          "bg-card absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-md border border-border shadow-lg",
        )}
        role="menu"
      >
        {choices.map((choice) => (
          <button
            key={`${choice.format}-${choice.scope}`}
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => download(choice)}
            className="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left text-sm disabled:opacity-50"
          >
            <span className="font-mono text-xs uppercase">{choice.format}</span>
            <span className="text-muted-foreground text-xs">{choice.label}</span>
          </button>
        ))}
        {error && (
          <p role="alert" className="text-destructive border-t border-border px-3 py-2 text-xs">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
