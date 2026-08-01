/**
 * The palette (GP-133): the catalog, grouped by category, one click per
 * resource. Everything the builder can make is here and nowhere else — the
 * list is `CATALOG`, so a resource type added to the package appears here
 * without this file learning its name.
 */
import {
  CATALOG,
  CATEGORIES,
  CATEGORY_LABELS,
  type ResourceCategory,
} from "@groundplan/builder";
import { ResourceIcon } from "@groundplan/canvas";

import { shortResourceType } from "./builder-node";

export function BuilderPalette({
  onAdd,
}: Readonly<{ onAdd: (type: string) => void }>) {
  return (
    <div
      className="bg-card border-border flex w-64 shrink-0 flex-col overflow-y-auto border-r"
      aria-label="Resource palette"
    >
      <div className="border-border border-b px-4 py-1.5">
        <span className="text-muted-foreground font-mono text-[11px] tracking-[0.12em] uppercase">
          Resources
        </span>
      </div>
      {CATEGORIES.map((category: ResourceCategory) => {
        const entries = CATALOG.filter((def) => def.category === category);
        if (entries.length === 0) return null;
        return (
          <section key={category} className="py-1">
            <h3 className="text-faint px-4 py-1 font-mono text-[10px] tracking-[0.12em] uppercase">
              {CATEGORY_LABELS[category]}
            </h3>
            <ul>
              {entries.map((def) => (
                <li key={def.type}>
                  <button
                    type="button"
                    onClick={() => onAdd(def.type)}
                    title={`${def.type} — ${def.description}`}
                    className="hover:bg-accent/60 flex w-full items-center gap-2 px-4 py-1 text-left"
                  >
                    <ResourceIcon type={def.type} className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {def.label}
                    </span>
                    <span className="text-faint shrink-0 font-mono text-[10px]">
                      {shortResourceType(def.type)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
