/**
 * The resource picker (GP-133, made dynamic in GP-238).
 *
 * It shows two things, and the order is the argument. **Quick starts** are the
 * curated dozen, grouped by category, and they are what a first-time user meets:
 * a short list somebody chose, with sensible defaults and real scaffold blocks.
 * **Search** reaches everything else the provider has — fifteen hundred types
 * nobody could put in a list worth scrolling.
 *
 * Search runs on the server (`?q=`), so the browser never holds the provider's
 * whole catalogue and there is no thousand-row list to virtualise. A schema is
 * fetched when a type is chosen, not before; until it arrives the entry says so.
 *
 * Freshness is stated, never implied: the footer names the provider version the
 * types come from and when it was read, and says "pinned" when this deployment
 * has turned the refresh off. A catalog that hid its own age would be the one
 * surface in this product that does.
 */
import { Braces, Loader2, Search, Shapes } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  CATALOG,
  CATEGORIES,
  CATEGORY_LABELS,
  type ProviderResourceSummary,
  type ResourceCategory,
} from "@groundplan/builder";
import { ResourceIcon } from "@groundplan/canvas";

import { Input } from "@/components/ui/input";

import { PALETTE_MIME } from "./builder-canvas";
import { shortResourceType } from "./builder-layout";
import { CUSTOM_TYPE, VARIABLE_TYPE } from "./builder-ops";
import { catalogKey, type CatalogState } from "./use-catalog";

const ENTRY =
  "hover:bg-accent/60 flex w-full cursor-grab items-center gap-2 px-4 py-1 text-left active:cursor-grabbing disabled:cursor-wait disabled:opacity-60";

const SECTION_HEADING =
  "text-faint px-4 py-1 font-mono text-[10px] tracking-[0.12em] uppercase";

function PaletteEntry({
  type,
  label,
  hint,
  title,
  icon,
  busy = false,
  onAdd,
}: Readonly<{
  type: string;
  label: string;
  hint: string;
  title: string;
  icon: React.ReactNode;
  busy?: boolean;
  onAdd: (type: string) => void;
}>) {
  return (
    <button
      type="button"
      draggable
      disabled={busy}
      onDragStart={(event) => {
        event.dataTransfer.setData(PALETTE_MIME, type);
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onAdd(type)}
      title={title}
      className={ENTRY}
    >
      {busy ? (
        <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
      ) : (
        icon
      )}
      <span className="min-w-0 flex-1 truncate text-xs">{label}</span>
      <span className="text-faint shrink-0 font-mono text-[10px]">{hint}</span>
    </button>
  );
}

/** "azurerm 4.81.0 · read 2 Aug" — or why there is nothing to read from. */
function CatalogFooter({ catalog }: Readonly<{ catalog: CatalogState }>) {
  const { active, warming, pinned, unavailable } = catalog;

  let line: string;
  if (active?.version) {
    const read = active.readAt
      ? new Date(active.readAt).toLocaleDateString(undefined, {
          day: "numeric",
          month: "short",
        })
      : null;
    line = [
      `${active.name} ${active.version}`,
      read ? `read ${read}` : null,
      pinned ? "pinned" : null,
    ]
      .filter(Boolean)
      .join(" · ");
  } else if (warming) {
    line = "catalog still being read — quick starts only";
  } else if (unavailable) {
    line = "catalog unavailable — quick starts only";
  } else {
    line = "quick starts only";
  }

  return (
    // Deliberately not a live region: the composition status bar owns that
    // role, and two of them would make "the status" ambiguous to a screen
    // reader and to anything else that looks for one.
    <p className="text-faint border-border border-t px-4 py-1.5 font-mono text-[10px]">
      {line}
    </p>
  );
}

export function BuilderPalette({
  onAdd,
  catalog,
}: Readonly<{
  onAdd: (type: string) => void;
  catalog: CatalogState;
}>) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProviderResourceSummary[]>([]);
  const [searching, setSearching] = useState(false);
  // Which search a result set belongs to, so a slow early request cannot
  // overwrite the answer to what the user has since typed.
  const latest = useRef(0);

  const { active, search } = catalog;
  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed === "" || !active) {
      setResults([]);
      setSearching(false);
      return;
    }
    const ticket = ++latest.current;
    setSearching(true);
    // Debounced: a keystroke is not a request, and the server is doing the
    // filtering precisely so this can stay cheap.
    const timer = setTimeout(() => {
      search(trimmed)
        .then((found) => {
          if (latest.current === ticket) setResults(found);
        })
        .catch(() => {
          if (latest.current === ticket) setResults([]);
        })
        .finally(() => {
          if (latest.current === ticket) setSearching(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [trimmed, active, search]);

  return (
    <div
      className="bg-card border-border flex w-64 shrink-0 flex-col overflow-hidden border-r"
      aria-label="Resource palette"
    >
      <div className="border-border border-b px-3 py-2">
        <div className="relative">
          <Search className="text-faint pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              active ? `Search ${active.name} resources` : "Search resources"
            }
            aria-label="Search resources"
            disabled={!active}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {trimmed === "" ? (
          <>
            {CATEGORIES.map((category: ResourceCategory) => {
              const entries = CATALOG.filter((def) => def.category === category);
              if (entries.length === 0) return null;
              return (
                <section key={category} className="py-1">
                  <h3 className={SECTION_HEADING}>
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
                            <ResourceIcon
                              type={def.type}
                              className="size-4 shrink-0"
                            />
                          }
                          onAdd={onAdd}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}

            {active && (
              <p className="text-muted-foreground px-4 py-2 text-[11px]">
                Search above for any of the {active.name} provider&rsquo;s other
                resources.
              </p>
            )}
          </>
        ) : (
          <section className="py-1">
            <h3 className={SECTION_HEADING}>
              {searching ? "Searching…" : `${results.length} matching`}
            </h3>
            {!searching && results.length === 0 && (
              <p className="text-muted-foreground px-4 py-2 text-[11px]">
                No resource type matches “{trimmed}”.
              </p>
            )}
            <ul>
              {results.map((resource) => (
                <li key={resource.type}>
                  <PaletteEntry
                    type={resource.type}
                    label={resource.type}
                    hint={`${resource.attributeCount}`}
                    title={
                      resource.summary
                        ? `${resource.type} — ${resource.summary}`
                        : resource.type
                    }
                    busy={catalog.loading.has(catalogKey(resource.type))}
                    icon={
                      <ResourceIcon
                        type={resource.type}
                        className="size-4 shrink-0"
                      />
                    }
                    onAdd={onAdd}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {/* Not resources: a value the composition takes in (GP-249), and the
          escape hatch for a resource no provider in the catalog describes —
          which costs the typed slots and the checked attributes, the honest
          trade for reaching something the catalog cannot see. */}
      <section className="border-border border-t py-1">
        <h3 className={SECTION_HEADING}>Anything else</h3>
        <ul>
          <li>
            <PaletteEntry
              type={VARIABLE_TYPE}
              label="Variable"
              hint="var"
              title="A value this composition takes in. Point any argument at it instead of typing a literal."
              icon={<Braces className="text-muted-foreground size-4 shrink-0" />}
              onAdd={onAdd}
            />
          </li>
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

      <CatalogFooter catalog={catalog} />
    </div>
  );
}
