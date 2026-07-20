/**
 * Export dialog for a snapshot (GP-37, GP-177): pick a format, and for
 * draw.io, which views become pages of the one downloaded file. The export
 * endpoints require auth, so we fetch the file as a Blob through the API
 * client (bearer token attached) and hand it to the browser as a download
 * rather than pointing an <a> straight at the URL.
 */
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

import {
  ApiError,
  getSnapshotExport,
  type ExportFormat,
  type ExportScope,
  type ExportView,
} from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type FormatKey = "svg" | "png" | "png-changes" | "drawio";

const FORMATS: {
  key: FormatKey;
  label: string;
  hint: string;
  format: ExportFormat;
  scope: ExportScope;
}[] = [
  { key: "svg", label: "SVG", hint: "Vector image", format: "svg", scope: "full" },
  { key: "png", label: "PNG", hint: "Raster image", format: "png", scope: "full" },
  { key: "png-changes", label: "PNG (changes only)", hint: "Just the diff", format: "png", scope: "changes" },
  { key: "drawio", label: "draw.io", hint: "Editable diagram for diagrams.net", format: "drawio", scope: "full" },
];

// Canonical page order — checking IAM before Network still downloads the same file.
const VIEWS: { key: ExportView; label: string }[] = [
  { key: "infra", label: "Infrastructure" },
  { key: "network", label: "Network" },
  { key: "iam", label: "IAM" },
];

export function ExportMenu({
  snapshotId,
  filenameBase,
  includeChangesScope = false,
}: Readonly<{
  snapshotId: string;
  /** Base name for the downloaded file, e.g. `infra-2c9f8061`. */
  filenameBase: string;
  /** Offer a "changes only" variant (PR view). */
  includeChangesScope?: boolean;
}>) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formatKey, setFormatKey] = useState<FormatKey>("svg");
  const [views, setViews] = useState<Set<ExportView>>(new Set(["infra"]));

  const formats = FORMATS.filter((f) => includeChangesScope || f.key !== "png-changes");
  const chosen = FORMATS.find((f) => f.key === formatKey)!;
  const chosenViews = VIEWS.map((v) => v.key).filter((v) => views.has(v));
  const needsViews = chosen.format === "drawio";

  const toggleView = (view: ExportView) => {
    setViews((prev) => {
      const next = new Set(prev);
      if (next.has(view)) next.delete(view);
      else next.add(view);
      return next;
    });
  };

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const exportViews = needsViews ? chosenViews : (["infra"] as ExportView[]);
      const blob = await getSnapshotExport(snapshotId, chosen.format, chosen.scope, exportViews);
      const url = URL.createObjectURL(blob);
      let suffix = "";
      if (needsViews && chosenViews.join() !== "infra") suffix = `-${chosenViews.join("-")}`;
      else if (chosen.scope === "changes") suffix = "-changes";
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filenameBase}${suffix}.${chosen.format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Download className="size-4" />
          Export
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export snapshot</DialogTitle>
          <DialogDescription>
            Server-rendered from the full snapshot — never the current filter state.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-1">
          <legend className="text-muted-foreground mb-1 text-xs font-medium uppercase">
            Format
          </legend>
          {formats.map((f) => (
            <label
              key={f.key}
              className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm"
            >
              <input
                type="radio"
                name="export-format"
                checked={formatKey === f.key}
                onChange={() => setFormatKey(f.key)}
              />
              <span>{f.label}</span>
              <span className="text-muted-foreground text-xs">{f.hint}</span>
            </label>
          ))}
        </fieldset>

        {needsViews && (
          <fieldset className="space-y-1">
            <legend className="text-muted-foreground mb-1 text-xs font-medium uppercase">
              Pages — one per view
            </legend>
            {VIEWS.map((v) => (
              <label
                key={v.key}
                className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm"
              >
                <input
                  type="checkbox"
                  checked={views.has(v.key)}
                  onChange={() => toggleView(v.key)}
                />
                {v.label}
              </label>
            ))}
          </fieldset>
        )}

        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <a
            href="/groundplan-shapes.xml"
            download
            className="text-muted-foreground text-xs underline underline-offset-2"
          >
            draw.io shape library
          </a>
          <Button onClick={download} disabled={busy || (needsViews && chosenViews.length === 0)}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
