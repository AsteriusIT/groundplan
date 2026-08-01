/**
 * Everything about the diff except whether it is on: which baseline, whether
 * to fold to the changed set, and what a static diff actually is.
 *
 * All three used to be permanent — a `<select>` and a checkbox in the toolbar,
 * and a note pinned to the canvas explaining, on every render, that this is
 * not a plan. They are settings and a caveat: worth having, not worth screen
 * space. The caveat text is the same string the status bar's ⓘ shows and the
 * first-run notice carries; there is one copy of it in `strings.ts`.
 */
import type { BaselineMode } from "../../src/messages";
import { strings } from "../strings";
import type { DiffFacts, DiffPrefs, PanelAction } from "../state/panel-state";
import { Popover } from "./popover";

const BASES: readonly { mode: BaselineMode; label: string }[] = [
  { mode: "head", label: strings.diff.baseHead },
  { mode: "merge-base", label: strings.diff.baseMergeBase },
];

export function DiffPopover({
  open,
  onClose,
  prefs,
  facts,
  onAction,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  prefs: DiffPrefs;
  facts: DiffFacts;
  onAction: (action: PanelAction) => void;
}>): React.JSX.Element | null {
  return (
    <Popover open={open} onClose={onClose} label={strings.diff.options} align="start">
      <fieldset className="border-0 p-0">
        <legend className="text-muted-foreground mb-1.5 font-mono text-[10px] uppercase tracking-wide">
          {strings.diff.baseLegend}
        </legend>
        <div role="radiogroup" aria-label={strings.diff.baseLegend}>
          {BASES.map(({ mode, label }) => (
            <label
              key={mode}
              className="text-foreground flex cursor-pointer items-center gap-2 py-0.5 text-xs"
            >
              <input
                type="radio"
                name="diff-base"
                className="accent-primary size-3"
                checked={prefs.mode === mode}
                onChange={() => onAction({ type: "setBase", mode })}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      {/* Nothing to fold without a diff — so it is disabled, not hidden: a
          control that vanishes teaches nothing about when it applies. */}
      <label
        title={strings.diff.changedOnlyHint}
        className="text-foreground mt-2 flex cursor-pointer items-center gap-2 border-t border-border pt-2 text-xs has-disabled:cursor-default has-disabled:opacity-50"
      >
        <input
          type="checkbox"
          className="accent-primary size-3"
          checked={prefs.changedOnly}
          disabled={!prefs.enabled}
          onChange={() => onAction({ type: "toggleChangedOnly" })}
        />
        {strings.diff.changedOnly}
      </label>

      {prefs.enabled && !facts.available && (
        <p className="text-warning mt-2 font-mono text-[10px]">
          {strings.diff.unavailable} — {facts.reason ?? "no baseline"}.
        </p>
      )}

      <div className="text-muted-foreground mt-2 border-t border-border pt-2">
        <AboutDiff />
      </div>
    </Popover>
  );
}

/** The caveat itself. One copy, three places that show it. */
function AboutDiff(): React.JSX.Element {
  return (
    <>
      <p className="text-foreground font-mono text-[10px] uppercase tracking-wide">
        {strings.diff.aboutTitle}
      </p>
      <p className="mt-1 text-[11px] leading-snug">{strings.diff.about}</p>
    </>
  );
}

/**
 * The same explanation, reached from the status bar's ⓘ rather than from the
 * diff options. It used to be a note pinned to the canvas on every render —
 * which is how a caveat stops being read.
 */
export function AboutDiffPopover({
  open,
  onClose,
}: Readonly<{ open: boolean; onClose: () => void }>): React.JSX.Element | null {
  return (
    <Popover
      open={open}
      onClose={onClose}
      label={strings.diff.aboutTitle}
      align="end"
      side="top"
    >
      <div className="text-muted-foreground">
        <AboutDiff />
      </div>
    </Popover>
  );
}
