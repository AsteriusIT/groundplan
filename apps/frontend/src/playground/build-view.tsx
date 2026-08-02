/**
 * The Playground's Build Editor view (GP-244): compose infrastructure on a
 * canvas instead of typing it.
 *
 * Experimental, and gated on `BUILDER_ENABLED` like everything else the builder
 * owns (GP-133): where the deployment has no builder the route is not a page
 * that says no, it is a redirect to the Editor — the same posture as an AI
 * route with no AI, one level down.
 */
import { Navigate } from "react-router-dom";
import { Loader2, Wand2 } from "lucide-react";

import { BuildMode } from "@/builder/build-mode";
import { Button } from "@/components/ui/button";
import { useBuilderStatus } from "@/lib/use-builder-status";

import { usePlayground } from "./playground-context";

export function PlaygroundBuildView() {
  const doc = usePlayground();
  const status = useBuilderStatus();

  // Unknown yet: render nothing rather than flashing a surface that may be
  // about to redirect (the `useBuilderStatus` contract).
  if (status === null) return <div className="flex-1" />;
  if (!status.enabled) return <Navigate to="/playground/editor" replace />;

  return (
    <BuildMode
      builder={doc.builder}
      catalog={doc.catalog}
      extraIssues={doc.serverIssues}
      actions={
        <Button
          onClick={() => void doc.generate()}
          disabled={!doc.builder.valid || doc.generating}
          title={
            doc.builder.valid
              ? undefined
              : "Fix the flagged resources before generating"
          }
        >
          {doc.generating ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Wand2 className="size-4" />
          )}
          {doc.generating ? "Generating…" : "Generate Terraform"}
        </Button>
      }
    />
  );
}
