import { useSearchParams } from "react-router-dom";
import { PencilLine } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Annotate mode (GP-58) is kept in the `?mode=annotate` query param — like
 * `?view` / `?compare` — so it survives reload and is deep-linkable. View mode
 * (param absent) shows annotations read-only; annotate mode enables editing.
 */
export function useAnnotateMode(): {
  annotate: boolean;
  setAnnotate: (on: boolean) => void;
} {
  const [params, setParams] = useSearchParams();
  const annotate = params.get("mode") === "annotate";
  const setAnnotate = (on: boolean): void => {
    const next = new URLSearchParams(params);
    if (on) next.set("mode", "annotate");
    else next.delete("mode");
    setParams(next, { replace: true });
  };
  return { annotate, setAnnotate };
}

/**
 * The view ⇄ annotate toggle for the docs toolbar. Rendered only where editing
 * is allowed — never on the public share view, so viewers see annotations but
 * no way to enter annotate mode.
 */
export function AnnotateToggle() {
  const { annotate, setAnnotate } = useAnnotateMode();
  return (
    <Button
      variant={annotate ? "default" : "outline"}
      onClick={() => setAnnotate(!annotate)}
    >
      <PencilLine className="size-4" />
      {annotate ? "Done annotating" : "Annotate"}
    </Button>
  );
}
