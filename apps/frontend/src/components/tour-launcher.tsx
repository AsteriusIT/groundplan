/**
 * GP-79: the way into a tour.
 *
 * Absent entirely when the AI layer is off — the same rule every AI surface obeys
 * (GP-62). Generation is always user-triggered: a tour costs money, and nobody
 * asked for one by opening a page.
 */
import { Loader2, Route } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAiStatus } from "@/lib/use-ai-status";
import type { TourPlayer } from "@/tour/use-tour";

export function TourLauncher({ player }: { player: TourPlayer }) {
  const status = useAiStatus();

  // No key, no model, no button. The feature does not exist rather than existing
  // and failing.
  if (!status?.enabled) return null;
  // While a tour runs, the chrome *is* the control — a second "take the tour"
  // button sitting next to a running tour is just a way to restart it by accident.
  if (player.status === "playing") return null;

  const loading = player.status === "loading";

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => player.start()}
        disabled={loading}
        className="h-7 gap-1.5 px-2.5 text-xs"
      >
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Route className="size-3.5" aria-hidden="true" />
        )}
        {loading ? "Building tour…" : "Take the tour"}
      </Button>
      {player.status === "error" && player.error ? (
        <span role="alert" className="text-delete text-xs">
          {player.error}
        </span>
      ) : null}
    </div>
  );
}
