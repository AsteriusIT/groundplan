/**
 * What the keyboard can do, written down where somebody might find it.
 *
 * A shortcut nobody knows about is a shortcut nobody has. This is the only
 * place the panel advertises them, and it is one click deep rather than
 * permanent — the same trade the legend makes.
 */
import { strings } from "../strings";

const SHORTCUTS: readonly { keys: string; does: string }[] = [
  { keys: "D", does: strings.shortcuts.diff },
  { keys: "1 2 3", does: strings.shortcuts.lens },
  { keys: "F", does: strings.shortcuts.fit },
  { keys: "/", does: strings.shortcuts.search },
  { keys: "Esc", does: strings.shortcuts.escape },
];

export function ShortcutList(): React.JSX.Element {
  return (
    <div className="mt-2 border-t border-border pt-2">
      <p className="text-muted-foreground mb-1 font-mono text-[10px] tracking-wide uppercase">
        {strings.shortcuts.title}
      </p>
      <dl className="flex flex-col gap-0.5">
        {SHORTCUTS.map(({ keys, does }) => (
          <div key={keys} className="flex items-baseline gap-2 text-[11px]">
            <dt className="border-border-strong bg-accent-soft text-foreground shrink-0 rounded-xs border px-1 font-mono text-[10px]">
              {keys}
            </dt>
            <dd className="text-muted-foreground">{does}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
