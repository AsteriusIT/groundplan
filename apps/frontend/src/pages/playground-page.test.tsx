import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, parsePlayground: vi.fn() };
});

vi.mock("@/components/graph-canvas", () => ({
  GraphCanvas: ({
    graph,
    variant,
  }: {
    graph: { nodes: unknown[] };
    variant: string;
  }) => (
    <div data-testid="canvas" data-variant={variant}>
      {graph.nodes.length} nodes
    </div>
  ),
}));

import { ApiError, parsePlayground } from "@/api/client";
import type { PlaygroundSnapshot } from "@/api/types";
import { PlaygroundPage } from "./playground-page";

const parsePlaygroundMock = vi.mocked(parsePlayground);

function snap(nodeCount: number): PlaygroundSnapshot {
  return {
    graph: {
      version: 1,
      nodes: Array.from({ length: nodeCount }, (_, i) => ({
        id: `n${i}`,
        name: `n${i}`,
        type: "azurerm_resource_group",
        provider: "azurerm",
        module_path: [],
        change: null,
      })),
      edges: [],
    },
    stats: {
      nodes: nodeCount,
      edges: 0,
      changes: { create: 0, update: 0, delete: 0, noop: 0, unchanged: nodeCount },
    },
    summaryMd: "",
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/playground"]}>
      <PlaygroundPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  parsePlaygroundMock.mockReset();
});

it("preloads a small Azure example so the page is never empty", () => {
  renderPage();

  expect(screen.getByText("main.tf")).toBeInTheDocument();
  expect(screen.getByText("network.tf")).toBeInTheDocument();
  // The editor shows the selected file's HCL.
  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: /file content/i,
  });
  expect(editor.value).toContain("azurerm_resource_group");
});

it("Visualize parses the current files and renders the canvas", async () => {
  parsePlaygroundMock.mockResolvedValue(snap(4));
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));

  expect(await screen.findByTestId("canvas")).toHaveTextContent("4 nodes");
  expect(screen.getByTestId("canvas")).toHaveAttribute("data-variant", "docs");
  const sent = parsePlaygroundMock.mock.calls[0]?.[0];
  expect(sent?.map((f) => f.path)).toEqual(["main.tf", "network.tf"]);
});

it("a parse failure names the file, marks it, and keeps the last good diagram", async () => {
  parsePlaygroundMock.mockResolvedValueOnce(snap(2));
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));
  expect(await screen.findByTestId("canvas")).toHaveTextContent("2 nodes");

  parsePlaygroundMock.mockRejectedValueOnce(
    new ApiError(422, "HCL parse failed", [
      { field: "main.tf", message: "unbalanced braces" },
    ]),
  );
  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("main.tf");
  expect(alert).toHaveTextContent("unbalanced braces");
  // The canvas still shows the last valid render.
  expect(screen.getByTestId("canvas")).toHaveTextContent("2 nodes");
});

it("adds a new file and removes one, all in local state", () => {
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: /add file/i }));
  expect(screen.getByText("untitled-1.tf")).toBeInTheDocument();

  fireEvent.click(
    screen.getByRole("button", { name: /delete untitled-1\.tf/i }),
  );
  expect(screen.queryByText("untitled-1.tf")).not.toBeInTheDocument();
});

it("renames a file inline", async () => {
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: /rename main\.tf/i }));
  const input = screen.getByRole("textbox", { name: /new name/i });
  fireEvent.change(input, { target: { value: "renamed.tf" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(await screen.findByText("renamed.tf")).toBeInTheDocument();
  expect(screen.queryByText("main.tf")).not.toBeInTheDocument();
});

it("editing the active file feeds the next parse", async () => {
  parsePlaygroundMock.mockResolvedValue(snap(1));
  renderPage();

  const editor = screen.getByRole("textbox", { name: /file content/i });
  fireEvent.change(editor, { target: { value: "# rewritten" } });
  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));

  await screen.findByTestId("canvas");
  const sent = parsePlaygroundMock.mock.calls[0]?.[0];
  expect(sent?.find((f) => f.path === "main.tf")?.content).toBe("# rewritten");
});

it("uploads .tf files through the file input", async () => {
  renderPage();

  const input = screen.getByLabelText(/upload files/i);
  const file = new File([`resource "a" "b" {}`], "uploaded.tf", {
    type: "text/plain",
  });
  fireEvent.change(input, { target: { files: [file] } });

  expect(await screen.findByText("uploaded.tf")).toBeInTheDocument();
});

it("has no axe violations", async () => {
  const { baseElement } = renderPage();
  await waitFor(async () => {
    const results = await axe(baseElement);
    expect(results.violations).toEqual([]);
  });
});
