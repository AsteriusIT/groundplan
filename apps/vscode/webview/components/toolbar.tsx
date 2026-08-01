/**
 * The panel's toolbar: which lens, and what the diff is doing.
 *
 * Two ideas, deliberately dressed apart. A segmented control says "pick one of
 * these views"; a split-button says "this is a tool, and it has settings". The
 * toolbar this replaces put eight same-weight controls in a row, so nothing
 * receded and the whole thing read as one long view switcher — then truncated
 * mid-word in a narrow panel.
 *
 * It reports actions rather than acting: the panel owns the state, this draws
 * it. Nothing here knows the host exists.
 */
import { Check, ChevronDown, GitCompareArrows, TriangleAlert } from "lucide-react";

import { cn } from "@groundplan/canvas";

import { strings } from "../strings";
import type { DiffCounts } from "../state/diff-summary";
import type {
  DiffFacts,
  DiffPrefs,
  Lens,
  PanelAction,
} from "../state/panel-state";
import type { Tier } from "../state/tier";

const LENSES: readonly { key: Lens; label: string }[] = [
  { key: "infra", label: strings.lens.infra },
  { key: "network", label: strings.lens.network },
  { key: "iam", label: strings.lens.iam },
];

/** One segment of the lens control. */
function Segment({
  label,
  active,
  onSelect,
  onKeyDown,
}: Readonly<{
  label: string;
  active: boolean;
  onSelect: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}>): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      // Roving tabindex: the segment group is one tab stop, and the arrow keys
      // move within it — the pattern a radiogroup owes its keyboard users.
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={cn(
        "px-2.5 py-1 font-mono text-xs uppercase tracking-wide",
        active
          ? "bg-accent-soft text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function LensSegments({
  lens,
  onAction,
}: Readonly<{
  lens: Lens;
  onAction: (action: PanelAction) => void;
}>): React.JSX.Element {
  const index = LENSES.findIndex((l) => l.key === lens);

  const move = (event: React.KeyboardEvent, delta: number): void => {
    event.preventDefault();
    // Wrap: the ends of a three-item group are not dead ends.
    const next = LENSES[(index + delta + LENSES.length) % LENSES.length];
    if (next) onAction({ type: "setLens", lens: next.key });
  };

  return (
    <div
      role="radiogroup"
      aria-label={strings.lens.label}
      className="border-border-strong bg-panel flex shrink-0 overflow-hidden rounded-sm border"
    >
      {LENSES.map(({ key, label }) => (
        <Segment
          key={key}
          label={label}
          active={lens === key}
          onSelect={() => onAction({ type: "setLens", lens: key })}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") move(event, 1);
            if (event.key === "ArrowLeft" || event.key === "ArrowUp") move(event, -1);
          }}
        />
      ))}
    </div>
  );
}

/**
 * The same choice as the segments, in the space of one control. A dropdown
 * rather than three squeezed labels: a segmented control that has run out of
 * room can only truncate, and half a word is not a label.
 */
function LensDropdown({
  lens,
  onAction,
}: Readonly<{
  lens: Lens;
  onAction: (action: PanelAction) => void;
}>): React.JSX.Element {
  return (
    <select
      aria-label={strings.lens.label}
      value={lens}
      onChange={(event) =>
        onAction({ type: "setLens", lens: event.target.value as Lens })
      }
      className="border-border-strong bg-panel text-foreground shrink-0 rounded-sm border px-1 py-1 font-mono text-xs"
    >
      {LENSES.map(({ key, label }) => (
        <option key={key} value={key}>
          {label}
        </option>
      ))}
    </select>
  );
}

/**
 * `+3 ~1 −2` in the change colours. A kind with nothing in it is not printed:
 * `+0` is noise that looks like information, and the reader is scanning for
 * the one number that says whether this diff is worth opening.
 */
function Counters({ counts }: Readonly<{ counts: DiffCounts }>): React.JSX.Element {
  return (
    <span className="flex items-center gap-1 tabular-nums">
      {counts.created > 0 && <span className="text-create">+{counts.created}</span>}
      {counts.updated > 0 && <span className="text-update">~{counts.updated}</span>}
      {counts.deleted > 0 && <span className="text-delete">−{counts.deleted}</span>}
    </span>
  );
}

/**
 * The diff control: a main region that turns the tool on and says what it is
 * comparing against, and a chevron that opens everything else. The counters
 * live in the button because "is this diff worth looking at" is the question
 * the button is there to answer.
 */
function DiffSplitButton({
  prefs,
  facts,
  counts,
  tier,
  optionsOpen,
  onToggleOptions,
  onAction,
  popover,
}: Readonly<{
  prefs: DiffPrefs;
  facts: DiffFacts;
  counts: DiffCounts | null;
  tier: Tier;
  optionsOpen: boolean;
  onToggleOptions: () => void;
  onAction: (action: PanelAction) => void;
  popover?: React.ReactNode;
}>): React.JSX.Element {
  const active = prefs.enabled && facts.available;
  const clean = active && (counts === null || counts.total === 0);

  // The visible label is a row of flex children: a screen reader concatenates
  // them with no separator ("Diffvs main+3") because the gaps are visual only.
  // So the name is stated, and the counters are spelled as words — "+3 ~1 −2"
  // read aloud is "plus three tilde one minus two", which is not a sentence.
  // "vs master" / "vs origin/release/2.4" — the branch is whatever the panel
  // was told, never a name written into the code.
  const against = strings.diff.against(
    strings.diff.baseLabel(prefs.mode, facts.defaultBranch),
  );

  const spokenName = [
    strings.diff.label,
    prefs.enabled ? against : null,
    prefs.enabled && !facts.available ? strings.diff.unavailable : null,
    clean ? strings.diff.clean : null,
    active && counts !== null && counts.total > 0
      ? strings.diff.spokenCounts(counts)
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");

  return (
    // `relative`: the popover anchors under the chevron, not under the bar.
    <div className="relative flex shrink-0 items-stretch">
      <button
        type="button"
        onClick={() => onAction({ type: "toggleDiff" })}
        aria-pressed={prefs.enabled}
        aria-label={spokenName}
        title={strings.diff.toggleHint}
        className={cn(
          "flex items-center gap-1.5 rounded-l-sm border border-r-0 px-2 py-1 font-mono text-xs shadow-sm",
          prefs.enabled
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border-strong bg-panel text-muted-foreground hover:text-foreground",
        )}
      >
        <GitCompareArrows className="size-3.5 shrink-0" />
        {strings.diff.label}
        {/* The baseline name is the first thing to go: the counts are why
            this button is worth its space, and the name is one click away in
            the popover. Dropped whole — never truncated to "vs ma…". */}
        {prefs.enabled && tier !== "narrow" && (
          <span className="opacity-80">{against}</span>
        )}
        {prefs.enabled && !facts.available && (
          <TriangleAlert
            className="text-warning size-3.5 shrink-0"
            aria-label={strings.diff.unavailable}
          />
        )}
        {clean && (
          <Check className="size-3.5 shrink-0" aria-label={strings.diff.clean} />
        )}
        {active && counts !== null && counts.total > 0 && <Counters counts={counts} />}
      </button>
      <button
        type="button"
        aria-label={strings.diff.options}
        aria-expanded={optionsOpen}
        aria-haspopup="dialog"
        onClick={onToggleOptions}
        className={cn(
          "flex items-center rounded-r-sm border px-1 py-1 shadow-sm",
          prefs.enabled
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border-strong bg-panel text-muted-foreground hover:text-foreground",
        )}
      >
        <ChevronDown
          className={cn("size-3.5 transition-transform", optionsOpen && "rotate-180")}
        />
      </button>
      {popover}
    </div>
  );
}

export function Toolbar({
  lens,
  prefs,
  facts,
  counts,
  tier = "wide",
  optionsOpen = false,
  onToggleOptions = () => {},
  onAction,
  diffPopover,
  children,
}: Readonly<{
  lens: Lens;
  /** How much room there is. Measured, not queried — see ../state/tier. */
  tier?: Tier;
  prefs: DiffPrefs;
  facts: DiffFacts;
  /** Null when there is no diff to count — the button then shows no numbers. */
  counts: DiffCounts | null;
  optionsOpen?: boolean;
  onToggleOptions?: () => void;
  onAction: (action: PanelAction) => void;
  /** Rendered inside the split-button so it hangs off the chevron. */
  diffPopover?: React.ReactNode;
  /** The right-hand cluster; filled in as its controls arrive. */
  children?: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label="Preview controls"
      className="border-border bg-panel flex shrink-0 items-center gap-2 border-b px-2 py-1.5"
    >
      {tier === "narrow" ? (
        <LensDropdown lens={lens} onAction={onAction} />
      ) : (
        <LensSegments lens={lens} onAction={onAction} />
      )}
      {/* A table has no diagram to colour, so the IAM lens has no diff. */}
      {lens !== "iam" && (
        <DiffSplitButton
          prefs={prefs}
          facts={facts}
          counts={counts}
          tier={tier}
          optionsOpen={optionsOpen}
          onToggleOptions={onToggleOptions}
          onAction={onAction}
          popover={diffPopover}
        />
      )}
      <div className="ml-auto flex items-center gap-1">{children}</div>
    </div>
  );
}
