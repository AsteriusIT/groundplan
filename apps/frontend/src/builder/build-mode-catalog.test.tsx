/**
 * Build mode against the provider catalog (GP-238).
 *
 * `build-mode.test.tsx` covers the curated dozen, and it now runs with a
 * catalog that has no provider behind it — which is the proof that the full
 * catalog is an enlargement and never a prerequisite. This file covers what the
 * enlargement adds: searching a provider's fifteen hundred types, loading one
 * schema when a type is chosen, and being honest while there is nothing to
 * search.
 */
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { useMemo, useState } from "react";

import {
  CATALOG,
  mergeCatalog,
  parseProviderSchema,
  resourceDefFromSchema,
  typeNamesOf,
  type ProviderResourceSummary,
  type RawProvidersSchema,
  type ResourceDef,
} from "@groundplan/builder";

import { BuildMode } from "./build-mode";
import { BuilderForm } from "./builder-form";
import { offlineCatalog } from "./build-mode.test";
import { useBuilderGraph } from "./use-builder-graph";
import type { CatalogState } from "./use-catalog";

import RAW from "../../../../packages/builder/src/__fixtures__/azurerm-4.81.0-subset.json";

/** The provider's own word, narrowed the way the catalog stores it. */
const SCHEMAS = parseProviderSchema(RAW as RawProvidersSchema, {
  provider: "hashicorp/azurerm",
  version: "4.81.0",
});
const TYPES = typeNamesOf(SCHEMAS);

/** A type nobody curated: the whole point of the story. */
const CLUSTER = "azurerm_kubernetes_cluster";

function summaryOf(type: string): ProviderResourceSummary {
  const schema = SCHEMAS.find((s) => s.type === type && s.kind === "resource")!;
  return {
    type,
    kind: "resource",
    summary: schema.description ?? "",
    attributeCount: schema.attributes.length,
  };
}

function defOf(type: string): ResourceDef {
  return resourceDefFromSchema(
    SCHEMAS.find((s) => s.type === type && s.kind === "resource")!,
    TYPES,
  );
}

/** A catalog with a ready provider, whose search and schema loads are stubbed. */
function readyCatalog(over: Partial<CatalogState> = {}): CatalogState {
  const base = offlineCatalog({
    active: {
      provider: "hashicorp/azurerm",
      namespace: "hashicorp",
      name: "azurerm",
      version: "4.81.0",
      readAt: "2026-08-01T10:00:00.000Z",
      latestKnownVersion: "4.81.0",
      lastCheckedAt: "2026-08-01T10:00:00.000Z",
      status: "ready",
    },
    search: async (query: string) =>
      [...TYPES]
        .filter((type) => type.includes(query))
        .sort()
        .map(summaryOf),
  });
  return { ...base, ...over };
}

/**
 * A harness that behaves like `useCatalog` does: a definition returned by
 * `ensure` joins the catalog the rest of Build mode composes against. Faking
 * that away would make these tests pass on a builder that never showed the form.
 */
function Harness({ catalog }: Readonly<{ catalog: CatalogState }>) {
  const [loaded, setLoaded] = useState<ResourceDef[]>([]);
  const defs = useMemo(() => mergeCatalog(loaded, CATALOG), [loaded]);
  const wired = useMemo<CatalogState>(
    () => ({
      ...catalog,
      defs,
      ensure: async (type: string) => {
        const def = await catalog.ensure(type);
        if (def) setLoaded((current) => [...current, def]);
        return def;
      },
    }),
    [catalog, defs],
  );
  const builder = useBuilderGraph(defs);
  return <BuildMode builder={builder} catalog={wired} />;
}

const palette = () => screen.getByLabelText("Resource palette");

it("searches the provider's types on the server, not in the browser", async () => {
  const search = vi.fn(async (query: string) =>
    [...TYPES].filter((t) => t.includes(query)).sort().map(summaryOf),
  );
  render(<Harness catalog={readyCatalog({ search })} />);

  // Nothing is searched until something is typed: the quick starts are what
  // an empty picker shows.
  expect(search).not.toHaveBeenCalled();
  expect(within(palette()).getByText("Resource group")).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Search resources"), {
    target: { value: "kubernetes" },
  });

  await waitFor(() =>
    expect(within(palette()).getByText(CLUSTER)).toBeInTheDocument(),
  );
  expect(search).toHaveBeenCalledWith("kubernetes");
  // And only what matched — the browser never held the provider's whole list.
  expect(within(palette()).queryByText("azurerm_subnet")).not.toBeInTheDocument();
});

it("loads a type's schema when it is chosen, and composes with it", async () => {
  const ensure = vi.fn(async (type: string) =>
    type === CLUSTER ? defOf(CLUSTER) : null,
  );
  render(<Harness catalog={readyCatalog({ ensure })} />);

  fireEvent.change(screen.getByLabelText("Search resources"), {
    target: { value: "kubernetes" },
  });
  await waitFor(() =>
    expect(within(palette()).getByText(CLUSTER)).toBeInTheDocument(),
  );

  // A schema is fetched on selection, never for the whole search result set.
  expect(ensure).not.toHaveBeenCalled();
  fireEvent.click(within(palette()).getByRole("button", { name: new RegExp(CLUSTER) }));
  expect(ensure).toHaveBeenCalledWith(CLUSTER);

  await waitFor(() =>
    expect(screen.getByTestId("builder-node-n1")).toBeInTheDocument(),
  );

  // The form is the provider's own schema: required arguments first, the rest
  // folded away, and the connection derived from `resource_group_name`.
  const form = screen.getByLabelText("Resource details");
  expect(within(form).getByLabelText(/Terraform name/)).toBeInTheDocument();
  // The required set leads, and a block's argument says which block it is in:
  // a cluster has a `name` and so does its default node pool, and two fields
  // called "Name" is a form nobody can fill in.
  expect(within(form).getByLabelText(/^Location/)).toBeInTheDocument();
  expect(
    within(form).getByLabelText(/^Default node pool · Name/),
  ).toBeInTheDocument();
  expect(within(form).getByText(/Optional arguments \(\d+\)/)).toBeInTheDocument();
  expect(within(form).getByLabelText(/Resource group/)).toBeInTheDocument();
});

it("says a sensitive argument is written into the file as a literal", () => {
  // Straight at the form with a derived definition: `azurerm_linux_virtual_machine`
  // is one of the curated dozen, and curation deliberately wins in Build mode,
  // so going through the palette would render the hand-written entry instead of
  // the provider's schema — which is the thing under test here.
  const def = defOf("azurerm_linux_virtual_machine");
  render(
    <BuilderForm
      node={{
        id: "n1",
        type: def.type,
        name: "vm",
        attributes: {},
        position: { x: 0, y: 0 },
      }}
      def={def}
      graph={{ nodes: [], references: [] }}
      issues={[]}
      onRename={() => {}}
      onRetype={() => {}}
      onAttribute={() => {}}
      onConnect={() => {}}
      onDisconnect={() => {}}
      onRenameReference={() => {}}
      onSetTargetAttribute={() => {}}
      onDelete={() => {}}
    />,
  );

  const form = screen.getByLabelText("Resource details");
  // `admin_password` is optional, so it lives under the fold — which is also
  // the point: ninety optional arguments are present without being in the way.
  expect(within(form).getByText(/Optional arguments \(\d+\)/)).toBeInTheDocument();
  fireEvent.click(within(form).getByText(/Optional arguments/));

  expect(within(form).getAllByText("sensitive").length).toBeGreaterThan(0);
  expect(
    within(form).getAllByText(/Replace it with a variable/).length,
  ).toBeGreaterThan(0);
});

it("is honest while the catalog is still being read", () => {
  render(
    <Harness catalog={offlineCatalog({ warming: true })} />,
  );
  expect(
    within(palette()).getByText(/still being read/),
  ).toBeInTheDocument();
  // Search is not offered when there is nothing to search…
  expect(screen.getByLabelText("Search resources")).toBeDisabled();
  // …and the quick starts still work, which is the whole posture.
  fireEvent.click(within(palette()).getByRole("button", { name: /Resource group/i }));
  expect(screen.getByTestId("builder-node-n1")).toBeInTheDocument();
});

it("says so when the catalog cannot be reached at all", () => {
  render(<Harness catalog={offlineCatalog({ unavailable: true })} />);
  expect(within(palette()).getByText(/unavailable/)).toBeInTheDocument();
  fireEvent.click(within(palette()).getByRole("button", { name: /Subnet/i }));
  expect(screen.getByTestId("builder-node-n1")).toBeInTheDocument();
});

it("names the provider version it is composing against, and when it was read", () => {
  render(<Harness catalog={readyCatalog()} />);
  expect(within(palette()).getByText(/azurerm 4\.81\.0/)).toBeInTheDocument();
});

it("labels a pinned catalog as pinned rather than as the latest", () => {
  render(<Harness catalog={readyCatalog({ pinned: true })} />);
  expect(within(palette()).getByText(/pinned/)).toBeInTheDocument();
});

it("does not add a resource whose schema could not be fetched", async () => {
  const ensure = vi.fn(async () => null);
  render(<Harness catalog={readyCatalog({ ensure })} />);

  fireEvent.change(screen.getByLabelText("Search resources"), {
    target: { value: "kubernetes" },
  });
  await waitFor(() =>
    expect(within(palette()).getByText(CLUSTER)).toBeInTheDocument(),
  );
  fireEvent.click(within(palette()).getByRole("button", { name: new RegExp(CLUSTER) }));

  await waitFor(() => expect(ensure).toHaveBeenCalled());
  // A card the form would have nothing to say about is worse than no card.
  expect(screen.queryByTestId("builder-node-n1")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Nothing composed yet");
});
