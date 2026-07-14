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
import type { GraphNode } from "@/api/types";
import { AZURE_ICON_KEYS, azureIconUrl } from "@/icons/azure-icons";
import { AWS_ICON_KEYS, awsIconUrl } from "@/icons/aws-icons";
import type { EdgeRel } from "@/lib/graph-layout";
import { ResourceIcon } from "@/components/resource-icon";
import { NodeCard } from "@/components/graph-node";
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

function mockNode(
  partial: Pick<GraphNode, "type" | "name" | "change"> & Partial<GraphNode>,
): GraphNode {
  return {
    id: `${partial.type}.${partial.name}`,
    provider: "azurerm",
    module_path: [],
    impacted: false,
    ...partial,
  };
}

const NODE_SAMPLES: { label: string; node: GraphNode; selected?: boolean }[] = [
  {
    label: "create",
    node: mockNode({ type: "azurerm_storage_account", name: "assets", change: "create" }),
  },
  {
    label: "update",
    node: mockNode({ type: "azurerm_mssql_database", name: "shop_db", change: "update" }),
  },
  {
    label: "delete",
    node: mockNode({ type: "azurerm_public_ip", name: "legacy", change: "delete" }),
  },
  {
    label: "noop",
    node: mockNode({ type: "azurerm_key_vault", name: "main", change: "noop" }),
  },
  {
    label: "impacted",
    node: mockNode({
      type: "azurerm_subnet",
      name: "internal",
      change: "noop",
      impacted: true,
      impact_distance: 2,
    }),
  },
  {
    label: "selected",
    node: mockNode({ type: "azurerm_kubernetes_cluster", name: "prod", change: "update" }),
    selected: true,
  },
];

const EDGE_SAMPLES: { rel: EdgeRel; label: string; stroke: string; dashed?: boolean }[] = [
  { rel: "new", label: "new dependency", stroke: "text-create" },
  { rel: "removed", label: "removed", stroke: "text-delete", dashed: true },
  { rel: "impact", label: "impact-carrying", stroke: "text-impacted" },
  { rel: "neutral", label: "plain dependency", stroke: "text-edge" },
];

/** One provider's vendored icon set, erased to strings for the gallery grid. */
function iconGallery<K extends string>(
  label: string,
  keys: readonly K[],
  url: (key: K) => string | undefined,
) {
  return {
    label,
    keys: keys as readonly string[],
    url: url as (key: string) => string | undefined,
  };
}

const ICON_GALLERIES = [
  iconGallery("Azure", AZURE_ICON_KEYS, azureIconUrl),
  iconGallery("AWS", AWS_ICON_KEYS, awsIconUrl),
];

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
              Official cloud provider icons, rendered as-is (Azure GP-29, AWS
              GP-91 — see <code className="font-mono text-xs">ICONS.md</code>).
              Unmapped types fall back to the lucide category icon, then a
              generic cube.
            </p>
            {ICON_GALLERIES.map((gallery) => (
              <div key={gallery.label} className="space-y-3">
                <h3 className="text-muted-foreground font-mono text-[11px] tracking-[0.08em] uppercase">
                  {gallery.label}
                </h3>
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
                  {gallery.keys.map((key) => (
                    <div
                      key={key}
                      className="bg-canvas border-border flex flex-col items-center gap-2 rounded-md border p-3"
                    >
                      <img
                        src={gallery.url(key)}
                        alt=""
                        aria-hidden="true"
                        draggable={false}
                        className="size-6 object-contain"
                      />
                      <span className="text-faint text-center font-mono text-[10px] break-all">
                        {key}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-6">
              <div className="flex items-center gap-2">
                <ResourceIcon type="aws_eip" className="text-cat-network size-5" />
                <span className="text-muted-foreground font-mono text-xs">
                  aws_eip → category
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

          <Section eyebrow="05 · diagram" title="Nodes & edges">
            <div className="space-y-3">
              <h3 className="text-muted-foreground font-mono text-[11px] tracking-[0.08em] uppercase">
                Node states — hover any card for the lift
              </h3>
              <div className="blueprint-grid grid grid-cols-1 gap-x-8 gap-y-6 rounded-md border border-border bg-canvas p-6 sm:grid-cols-2 lg:grid-cols-3">
                {NODE_SAMPLES.map((sample) => (
                  <div key={sample.label} className="flex flex-col gap-1.5">
                    <span className="text-faint font-mono text-[10px] tracking-[0.08em] uppercase">
                      {sample.label}
                    </span>
                    <div className="h-14 w-56">
                      <NodeCard graphNode={sample.node} selected={sample.selected} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-muted-foreground font-mono text-[11px] tracking-[0.08em] uppercase">
                Edges — coloured by relationship
              </h3>
              <div className="bg-canvas border-border grid grid-cols-2 gap-4 rounded-md border p-4 sm:grid-cols-4">
                {EDGE_SAMPLES.map((edge) => (
                  <div key={edge.rel} className="flex flex-col items-center gap-2">
                    <svg
                      viewBox="0 0 80 12"
                      className={cn("h-3 w-20", edge.stroke)}
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M2 6 H66"
                        stroke="currentColor"
                        strokeWidth={1.5}
                        strokeDasharray={edge.dashed ? "6 4" : undefined}
                      />
                      <path
                        d="M66 2 L74 6 L66 10 Z"
                        fill="currentColor"
                        stroke="none"
                      />
                    </svg>
                    <span className="text-faint text-center font-mono text-[10px]">
                      {edge.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
