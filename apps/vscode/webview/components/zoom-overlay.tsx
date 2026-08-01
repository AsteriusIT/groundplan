/**
 * Zoom, as a quiet overlay in the corner the diagram can spare.
 *
 * The one thing that stays on the drawing, because it is the one control that
 * acts *on* the drawing rather than describing it — reaching for a toolbar to
 * zoom means leaving the thing you are zooming.
 *
 * In diff mode "fit" means fit the changes: framing the whole estate to answer
 * "what moved" is exactly the wrong answer, and the blast radius is what the
 * reader came for. With nothing changed, it frames everything — which is the
 * honest response to "show me the changes" when there are none.
 */
import { Maximize2, Minus, Plus } from "lucide-react";

import { strings } from "../strings";

export function ZoomOverlay({
  onZoomIn,
  onZoomOut,
  onFit,
  fitsChanges,
}: Readonly<{
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  /** True in diff mode: the fit button frames the change set, and says so. */
  fitsChanges: boolean;
}>): React.JSX.Element {
  return (
    <div className="border-border bg-panel/90 absolute right-3 bottom-3 z-10 flex flex-col overflow-hidden rounded-sm border shadow-sm backdrop-blur">
      <Button label={strings.zoom.in} onClick={onZoomIn}>
        <Plus className="size-3.5" />
      </Button>
      <Button label={strings.zoom.out} onClick={onZoomOut} bordered>
        <Minus className="size-3.5" />
      </Button>
      <Button
        label={fitsChanges ? strings.zoom.fitChanges : strings.zoom.fit}
        onClick={onFit}
        bordered
      >
        <Maximize2 className="size-3.5" />
      </Button>
    </div>
  );
}

function Button({
  label,
  onClick,
  bordered = false,
  children,
}: Readonly<{
  label: string;
  onClick: () => void;
  bordered?: boolean;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={
        "text-muted-foreground hover:text-foreground hover:bg-accent-soft flex items-center justify-center p-1.5" +
        (bordered ? " border-t border-border" : "")
      }
    >
      {children}
    </button>
  );
}
