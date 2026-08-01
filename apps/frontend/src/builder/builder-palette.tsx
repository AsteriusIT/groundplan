/**
 * The palette (GP-133): the catalog, grouped by category. Everything the
 * builder can make is here and nowhere else — the list is `CATALOG`, so a
 * resource type added to the package appears here without this file learning
 * its name.
 *
 * Two ways to place one, because both are the obvious one to somebody: drag it
 * where you want it, or click and let it land under what is already there.
 */
import { Shapes } from "lucide-react";

import {
  CATALOG,
  CATEGORIES,
  CATEGORY_LABELS,
  type ResourceCategory,
} from "@groundplan/builder";
import { ResourceIcon } from "@groundplan/canvas";

import { PALETTE_MIME } from "./builder-canvas";
import { shortResourceType } from "./builder-node";
import { CUSTOM_TYPE } from "./builder-ops";

const ENTRY =
  "hover:bg-accent/60 flex w-full cursor-grab items-center gap-2 px-4 py-1 text-left active:cursor-grabbing";

function PaletteEntry({
  type,
  label,
  hint,
  title,
  icon,
  onAdd,
}: Readonly<{
  type: string;
  label: string;
  hint: string;
  title: string;
  icon: React.ReactNode;
  onAdd: (type: string) => void;
}>) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(PALETTE_MIME, type);
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onAdd(type)}
      title={title}
      className={ENTRY}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
      <span className="text-faint shrink-0 font-mono text-[10px]">{hint}</span>
    </button>
  );
}

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
                  <PaletteEntry
                    type={def.type}
                    label={def.label}
                    hint={shortResourceType(def.type)}
                    title={`${def.type} — ${def.description}`}
                    icon={
                      <ResourceIcon type={def.type} className="size-4 shrink-0" />
                    }
                    onAdd={onAdd}
                  />
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {/* The escape hatch: a resource the catalog does not describe. It costs
          the typed slots and the checked attributes — the type and the fields
          are the user's word — which is the honest trade for reaching a
          resource nobody curated. */}
      <section className="border-border mt-auto border-t py-1">
        <h3 className="text-faint px-4 py-1 font-mono text-[10px] tracking-[0.12em] uppercase">
          Anything else
        </h3>
        <ul>
          <li>
            <PaletteEntry
              type={CUSTOM_TYPE}
              label="Custom resource"
              hint="any type"
              title="Any Terraform resource type, with attributes you write yourself. Nothing about it is checked beyond syntax."
              icon={<Shapes className="text-muted-foreground size-4 shrink-0" />}
              onAdd={onAdd}
            />
          </li>
        </ul>
      </section>
    </div>
  );
}
