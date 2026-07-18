import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    parsePlayground: vi.fn(),
    listPlaygroundDrafts: vi.fn(),
    getPlaygroundDraft: vi.fn(),
    createPlaygroundDraft: vi.fn(),
    updatePlaygroundDraft: vi.fn(),
    deletePlaygroundDraft: vi.fn(),
  };
});

// The real editor (CodeMirror) is covered by hcl-editor.test.tsx; here a
// textarea stand-in keeps the page tests black-box and jsdom-simple.
vi.mock("@/components/hcl-editor", () => ({
  HclEditor: ({
    value,
    onChange,
    ariaLabel,
    errorLine,
  }: {
    value: string;
    onChange: (content: string) => void;
    ariaLabel: string;
    errorLine?: number | null;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-error-line={errorLine ?? ""}
    />
  ),
}));

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

import {
  ApiError,
  createPlaygroundDraft,
  deletePlaygroundDraft,
  getPlaygroundDraft,
  listPlaygroundDrafts,
  parsePlayground,
  updatePlaygroundDraft,
} from "@/api/client";
import type { PlaygroundDraft, PlaygroundSnapshot } from "@/api/types";
import { PlaygroundPage } from "./playground-page";

const parsePlaygroundMock = vi.mocked(parsePlayground);
const listDraftsMock = vi.mocked(listPlaygroundDrafts);
const getDraftMock = vi.mocked(getPlaygroundDraft);
const createDraftMock = vi.mocked(createPlaygroundDraft);
const updateDraftMock = vi.mocked(updatePlaygroundDraft);
const deleteDraftMock = vi.mocked(deletePlaygroundDraft);

const DRAFT: PlaygroundDraft = {
  id: "d1",
  userId: "u1",
  name: "azure sketch",
  files: [
    { path: "saved.tf", content: `resource "azurerm_storage_account" "sa" {}` },
  ],
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
};

const DRAFT_SUMMARY = {
  id: "d1",
  name: "azure sketch",
  updatedAt: "2026-07-02T00:00:00.000Z",
  fileCount: 1,
};

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
  listDraftsMock.mockReset().mockResolvedValue([]);
  getDraftMock.mockReset();
  createDraftMock.mockReset();
  updateDraftMock.mockReset();
  deleteDraftMock.mockReset();
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

it("hands the parse error's line to the failing file's editor (GP-127)", async () => {
  parsePlaygroundMock.mockRejectedValueOnce(
    new ApiError(422, "HCL parse failed", [
      { field: "main.tf", message: "unbalanced braces at line 3" },
    ]),
  );
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));
  await screen.findByRole("alert");

  // main.tf is the active file — its editor gets the line.
  const editor = screen.getByRole("textbox", { name: /file content/i });
  expect(editor).toHaveAttribute("data-error-line", "3");
});

it("does not mark the editor when the error is in another file", async () => {
  parsePlaygroundMock.mockRejectedValueOnce(
    new ApiError(422, "HCL parse failed", [
      { field: "network.tf", message: "unbalanced braces at line 2" },
    ]),
  );
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));
  await screen.findByRole("alert");

  const editor = screen.getByRole("textbox", { name: /file content/i });
  expect(editor).toHaveAttribute("data-error-line", "");
});

/** Radix opens a menu on keyboard activation; jsdom has no real pointer. */
function openAddMenu() {
  fireEvent.keyDown(
    screen.getByRole("button", { name: /add or upload files/i }),
    { key: "Enter" },
  );
}

it("adds a new file from the + menu, all in local state", async () => {
  renderPage();

  openAddMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /new file/i }));
  expect(screen.getByText("untitled-1.tf")).toBeInTheDocument();
});

it("deletes a file only after an inline confirmation (GP-128)", async () => {
  renderPage();

  openAddMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /new file/i }));

  fireEvent.click(
    screen.getByRole("button", { name: /delete untitled-1\.tf/i }),
  );
  // Nothing removed yet — the confirm is the decision point.
  expect(screen.getByText("untitled-1.tf")).toBeInTheDocument();

  fireEvent.click(
    screen.getByRole("button", { name: /confirm delete untitled-1\.tf/i }),
  );
  expect(screen.queryByText("untitled-1.tf")).not.toBeInTheDocument();
});

it("marks a file modified since the last Visualize, cleared by the next one", async () => {
  parsePlaygroundMock.mockResolvedValue(snap(1));
  renderPage();

  // No Visualize yet — nothing to be modified *since*.
  expect(screen.queryByLabelText(/modified since/i)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));
  await screen.findByTestId("canvas");
  expect(screen.queryByLabelText(/modified since/i)).not.toBeInTheDocument();

  fireEvent.change(screen.getByRole("textbox", { name: /file content/i }), {
    target: { value: "# touched" },
  });
  expect(
    screen.getByLabelText(/main\.tf modified since last visualize/i),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));
  await waitFor(() =>
    expect(screen.queryByLabelText(/modified since/i)).not.toBeInTheDocument(),
  );
});

it("identifies the selected file and follows selection", () => {
  renderPage();

  expect(screen.getByRole("button", { name: "main.tf" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "network.tf" }));
  expect(screen.getByRole("button", { name: "network.tf" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(screen.getByRole("button", { name: "main.tf" })).not.toHaveAttribute(
    "aria-current",
  );
});

it("collapses the files panel to a rail and expands it back", () => {
  renderPage();

  fireEvent.click(
    screen.getByRole("button", { name: /collapse files panel/i }),
  );
  expect(screen.queryByText("main.tf")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /expand files panel/i }));
  expect(screen.getByText("main.tf")).toBeInTheDocument();
});

it("resizes the files panel from its edge handle", () => {
  renderPage();

  const handle = screen.getByRole("separator", {
    name: /resize files panel/i,
  });
  const before = Number(handle.getAttribute("aria-valuenow"));
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(Number(handle.getAttribute("aria-valuenow"))).toBe(before + 16);
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(Number(handle.getAttribute("aria-valuenow"))).toBe(before);
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

  const input = screen.getByLabelText(/upload files/i, { selector: "input" });
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

// ---------------------------------------------------------------------------
// Drafts (GP-126): save, list, open, rename, delete — and the dirty guard.
// ---------------------------------------------------------------------------

it("saves the playground as a named draft and shows the name", async () => {
  createDraftMock.mockImplementation(async (input) => ({
    ...DRAFT,
    name: input.name,
    files: input.files,
  }));
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
  const nameInput = await screen.findByLabelText(/draft name/i);
  fireEvent.change(nameInput, { target: { value: "my stack" } });
  fireEvent.click(screen.getByRole("button", { name: /save draft/i }));

  await waitFor(() => expect(createDraftMock).toHaveBeenCalledTimes(1));
  const input = createDraftMock.mock.calls[0]?.[0];
  expect(input?.name).toBe("my stack");
  expect(input?.files.map((f) => f.path)).toEqual(["main.tf", "network.tf"]);
  expect(await screen.findByText("my stack")).toBeInTheDocument();
});

it("Save updates the current draft — no duplication", async () => {
  createDraftMock.mockImplementation(async (input) => ({
    ...DRAFT,
    name: input.name,
    files: input.files,
  }));
  updateDraftMock.mockResolvedValue(DRAFT);
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: /save as draft/i }));
  fireEvent.change(await screen.findByLabelText(/draft name/i), {
    target: { value: "my stack" },
  });
  fireEvent.click(screen.getByRole("button", { name: /save draft/i }));
  await waitFor(() => expect(createDraftMock).toHaveBeenCalledTimes(1));

  fireEvent.change(screen.getByRole("textbox", { name: /file content/i }), {
    target: { value: "# edited" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

  await waitFor(() => expect(updateDraftMock).toHaveBeenCalledTimes(1));
  const [id, payload] = updateDraftMock.mock.calls[0] ?? [];
  expect(id).toBe("d1");
  expect(
    payload?.files?.find((f) => f.path === "main.tf")?.content,
  ).toBe("# edited");
  expect(createDraftMock).toHaveBeenCalledTimes(1);
});

it("opens a draft: files restored, parse re-runs automatically", async () => {
  listDraftsMock.mockResolvedValue([DRAFT_SUMMARY]);
  getDraftMock.mockResolvedValue(DRAFT);
  parsePlaygroundMock.mockResolvedValue(snap(1));
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: /^drafts$/i }));
  fireEvent.click(
    await screen.findByRole("button", { name: /open azure sketch/i }),
  );

  expect(await screen.findByText("saved.tf")).toBeInTheDocument();
  await waitFor(() => expect(parsePlaygroundMock).toHaveBeenCalledTimes(1));
  expect(parsePlaygroundMock.mock.calls[0]?.[0]).toEqual(DRAFT.files);
  expect(await screen.findByTestId("canvas")).toHaveTextContent("1 nodes");
});

it("a draft that no longer parses still opens, error on display", async () => {
  listDraftsMock.mockResolvedValue([DRAFT_SUMMARY]);
  getDraftMock.mockResolvedValue(DRAFT);
  parsePlaygroundMock.mockRejectedValue(
    new ApiError(422, "HCL parse failed", [
      { field: "saved.tf", message: "unbalanced braces" },
    ]),
  );
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: /^drafts$/i }));
  fireEvent.click(
    await screen.findByRole("button", { name: /open azure sketch/i }),
  );

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("saved.tf");
  // The editor stays usable — a draft may be invalid, it is a draft.
  expect(
    screen.getByRole("textbox", { name: /file content/i }),
  ).toBeInTheDocument();
});

it("renames a draft from the list", async () => {
  listDraftsMock.mockResolvedValue([DRAFT_SUMMARY]);
  updateDraftMock.mockResolvedValue({ ...DRAFT, name: "renamed" });
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: /^drafts$/i }));
  fireEvent.click(
    await screen.findByRole("button", { name: /rename azure sketch/i }),
  );
  const input = screen.getByRole("textbox", { name: /new draft name/i });
  fireEvent.change(input, { target: { value: "renamed" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() =>
    expect(updateDraftMock).toHaveBeenCalledWith("d1", { name: "renamed" }),
  );
});

it("deletes a draft only after confirmation", async () => {
  listDraftsMock.mockResolvedValue([DRAFT_SUMMARY]);
  deleteDraftMock.mockResolvedValue(undefined);
  renderPage();

  fireEvent.click(screen.getByRole("button", { name: /^drafts$/i }));
  fireEvent.click(
    await screen.findByRole("button", { name: /delete azure sketch/i }),
  );
  expect(deleteDraftMock).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /delete draft/i }));
  await waitFor(() => expect(deleteDraftMock).toHaveBeenCalledWith("d1"));
});

it("warns before unload only when there are unsaved changes", () => {
  renderPage();

  const pristine = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(pristine);
  expect(pristine.defaultPrevented).toBe(false);

  fireEvent.change(screen.getByRole("textbox", { name: /file content/i }), {
    target: { value: "# touched" },
  });
  expect(screen.getByLabelText(/unsaved changes/i)).toBeInTheDocument();

  const dirty = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(dirty);
  expect(dirty.defaultPrevented).toBe(true);
});
