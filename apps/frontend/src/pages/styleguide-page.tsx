/**
 * /styleguide (GP-28) — a dev-only living reference for the blueprint design
 * system: every colour token, the type scale, and the shared primitives
 * (Chip, StatusBadge, SidePanel). Later stories extend it — GP-30 adds the node
 * and edge states, GP-33 the full detail panel. Not shipped in production
 * (the route is registered only when `import.meta.env.DEV`).
 */
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { STATUS_META, type StatusKind } from "@/lib/status";
import { CATEGORY_META } from "@/lib/resource-category";
import { AZURE_GLYPHS, type AzureGlyphKey } from "@/icons/azure-glyphs";
import { ResourceIcon } from "@/components/resource-icon";
import { Chip } from "@/components/ui/chip";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  SidePanel,
  SidePanelBody,
  SidePanelHeader,
  SidePanelSection,
} from "@/components/ui/side-panel";

/** Read a CSS custom property's resolved value off the document root. */
function useCssVar(token: string): string {
  const [value, setValue] = useState("");
  useEffect(() => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue(token)
      .trim();
    setValue(raw);
  }, [token]);
  return value;
}

function Swatch({
  name,
  token,
  swatchClass,
}: {
  name: string;
  token: string;
  swatchClass: string;
}) {
  const hex = useCssVar(token);
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          "border-border-strong size-10 shrink-0 rounded-md border",
          swatchClass,
        )}
      />
      <div className="min-w-0">
        <p className="text-ink font-mono text-xs">{name}</p>
        <p className="text-faint font-mono text-[10px]">{hex || token}</p>
      </div>
    </div>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-muted-foreground mb-3 font-mono text-[11px] font-medium tracking-[0.08em] uppercase">
        {title}
      </h3>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {children}
      </div>
    </div>
  );
}

function Section({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border border-t pt-10">
      <p className="text-primary font-mono text-[11px] tracking-[0.12em] uppercase">
        {eyebrow}
      </p>
      <h2 className="font-display text-ink mt-1 mb-6 text-2xl font-semibold">
        {title}
      </h2>
      <div className="space-y-8">{children}</div>
    </section>
  );
}

const STATUS_KINDS: StatusKind[] = ["create", "update", "delete", "impacted"];

const GLYPH_KEYS = Object.keys(AZURE_GLYPHS) as AzureGlyphKey[];

export function StyleguidePage() {
  return (
    <div className="blueprint-grid bg-background min-h-screen">
      <div className="mx-auto max-w-5xl px-6 py-14 md:px-10">
        <header className="mb-12">
          <p className="text-primary font-mono text-xs tracking-[0.12em] uppercase">
            Groundplan · design system
          </p>
          <h1 className="font-display text-ink mt-2 text-4xl font-bold tracking-tight">
            Blueprint
          </h1>
          <p className="text-muted-foreground mt-3 max-w-xl text-sm">
            The single source of visual truth — tokens and primitives every view
            is built from. Dev-only reference (GP-28).
          </p>
        </header>

        <div className="space-y-12">
          <Section eyebrow="01 · colour" title="Tokens">
            <Group title="Surfaces">
              <Swatch name="background" token="--background" swatchClass="bg-background" />
              <Swatch name="canvas" token="--canvas" swatchClass="bg-canvas" />
              <Swatch name="panel / card" token="--panel" swatchClass="bg-panel" />
              <Swatch name="muted" token="--muted" swatchClass="bg-muted" />
            </Group>
            <Group title="Ink">
              <Swatch name="ink" token="--ink" swatchClass="bg-ink" />
              <Swatch name="muted-foreground" token="--muted-foreground" swatchClass="bg-muted-foreground" />
              <Swatch name="faint" token="--faint" swatchClass="bg-faint" />
              <Swatch name="border-strong" token="--border-strong" swatchClass="bg-border-strong" />
            </Group>
            <Group title="Accent & lines">
              <Swatch name="primary" token="--primary" swatchClass="bg-primary" />
              <Swatch name="accent-soft" token="--accent-soft" swatchClass="bg-accent-soft" />
              <Swatch name="border" token="--border" swatchClass="bg-border" />
              <Swatch name="edge" token="--edge" swatchClass="bg-edge" />
            </Group>
            <Group title="Status">
              <Swatch name="create" token="--create" swatchClass="bg-create" />
              <Swatch name="update" token="--update" swatchClass="bg-update" />
              <Swatch name="delete" token="--delete" swatchClass="bg-delete" />
              <Swatch name="impacted" token="--impacted" swatchClass="bg-impacted" />
              <Swatch name="create-soft" token="--create-soft" swatchClass="bg-create-soft" />
              <Swatch name="update-soft" token="--update-soft" swatchClass="bg-update-soft" />
              <Swatch name="delete-soft" token="--delete-soft" swatchClass="bg-delete-soft" />
              <Swatch name="impacted-soft" token="--impacted-soft" swatchClass="bg-impacted-soft" />
            </Group>
            <Group title="Categories">
              {(Object.keys(CATEGORY_META) as (keyof typeof CATEGORY_META)[]).map(
                (cat) => (
                  <Swatch
                    key={cat}
                    name={CATEGORY_META[cat].label}
                    token={`--cat-${cat}`}
                    swatchClass={`bg-cat-${cat}`}
                  />
                ),
              )}
            </Group>
          </Section>

          <Section eyebrow="02 · type" title="Typography">
            <div className="space-y-4">
              <p className="font-display text-ink text-4xl font-bold">
                Space Grotesk — display
              </p>
              <p className="text-ink text-lg">
                Inter — body copy for descriptions and running prose.
              </p>
              <p className="text-ink font-mono text-sm">
                IBM Plex Mono — module.payments.aws_ecs_service.this · 3f9a1c2
              </p>
              <div className="text-faint flex flex-wrap gap-4 font-mono text-[11px] tracking-[0.08em] uppercase">
                <span>Section label</span>
                <span>Terraform address</span>
                <span>Commit sha</span>
              </div>
            </div>
          </Section>

          <Section eyebrow="03 · primitives" title="Chip, Badge, SidePanel">
            <div className="space-y-3">
              <h3 className="text-muted-foreground font-mono text-[11px] tracking-[0.08em] uppercase">
                Chip
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                <Chip variant="create">+12 create</Chip>
                <Chip variant="update">~3 update</Chip>
                <Chip variant="delete">−1 delete</Chip>
                <Chip variant="impacted">! 5 impacted</Chip>
                <Chip variant="neutral">42 total</Chip>
                <Chip variant="accent">auto</Chip>
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-muted-foreground font-mono text-[11px] tracking-[0.08em] uppercase">
                StatusBadge
              </h3>
              <div className="bg-canvas border-border flex flex-wrap items-center gap-5 rounded-md border p-4">
                {STATUS_KINDS.map((kind) => (
                  <div key={kind} className="flex flex-col items-center gap-1.5">
                    <StatusBadge kind={kind} />
                    <span className="text-faint font-mono text-[10px]">
                      {STATUS_META[kind].glyph} {kind}
                    </span>
                  </div>
                ))}
                {STATUS_KINDS.map((kind) => (
                  <StatusBadge key={`sm-${kind}`} kind={kind} size="sm" />
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-muted-foreground font-mono text-[11px] tracking-[0.08em] uppercase">
                SidePanel
              </h3>
              <div className="bg-canvas border-border relative h-80 overflow-hidden rounded-md border">
                <SidePanel label="Example panel">
                  <SidePanelHeader onClose={() => {}}>
                    <p className="text-muted-foreground font-mono text-[10px] tracking-[0.08em] uppercase">
                      Resource
                    </p>
                    <p className="font-display text-sm font-semibold">this</p>
                    <div className="mt-2 flex gap-1.5">
                      <Chip variant="update">
                        <StatusBadge kind="update" size="sm" className="-ml-0.5 ring-0" />
                        Update
                      </Chip>
                    </div>
                  </SidePanelHeader>
                  <SidePanelBody>
                    <SidePanelSection label="Terraform address">
                      <code className="bg-accent-soft text-primary block rounded-md px-2 py-1.5 font-mono text-xs">
                        azurerm_mssql_database.shop_db
                      </code>
                    </SidePanelSection>
                    <SidePanelSection label="Provider">
                      <p className="font-mono text-sm">azurerm</p>
                    </SidePanelSection>
                  </SidePanelBody>
                </SidePanel>
              </div>
            </div>
          </Section>

          <Section eyebrow="04 · icons" title="Resource icons">
            <p className="text-muted-foreground -mt-2 max-w-xl text-sm">
              Original blueprint line-glyphs for the common Azure service
              families (GP-29), tinted by category via <code className="font-mono text-xs">currentColor</code>.
              Unmapped types fall back to the category icon, then a generic cube.
            </p>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
              {GLYPH_KEYS.map((glyph) => (
                <div
                  key={glyph}
                  className="bg-canvas border-border flex flex-col items-center gap-2 rounded-md border p-3"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.7}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-cat-compute size-6"
                    aria-hidden="true"
                  >
                    {AZURE_GLYPHS[glyph]}
                  </svg>
                  <span className="text-faint text-center font-mono text-[10px] break-all">
                    {glyph}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-6">
              <div className="flex items-center gap-2">
                <ResourceIcon type="aws_instance" className="text-cat-compute size-5" />
                <span className="text-muted-foreground font-mono text-xs">
                  aws_instance → category
                </span>
              </div>
              <div className="flex items-center gap-2">
                <ResourceIcon type="mystery_thing" className="text-cat-other size-5" />
                <span className="text-muted-foreground font-mono text-xs">
                  unknown → generic cube
                </span>
              </div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
