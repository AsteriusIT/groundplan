import { beforeEach, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    parsePlayground: vi.fn(),
    getBuilderStatus: vi.fn(),
    generateBuilderTerraform: vi.fn(),
    listPlaygroundDrafts: vi.fn(),
    getPlaygroundDraft: vi.fn(),
    createPlaygroundDraft: vi.fn(),
    updatePlaygroundDraft: vi.fn(),
    deletePlaygroundDraft: vi.fn(),
  };
});

// The real editor (CodeMirror) is covered by hcl-editor.test.tsx; here a
// textarea stand-in keeps the view tests black-box and jsdom-simple.
vi.mock("@/components/hcl-editor", () => ({
  HclEditor: ({
    value,
    onChange,
    ariaLabel,
    errorLine,
    locatedLine,
    docId,
  }: {
    value: string;
    onChange: (content: string) => void;
    ariaLabel: string;
    errorLine?: number | null;
    locatedLine?: number | null;
    docId?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-error-line={errorLine ?? ""}
      data-located-line={locatedLine ?? ""}
      data-doc-id={docId ?? ""}
    />
  ),
}));

vi.mock("@/components/graph-canvas", () => ({
  GraphCanvas: ({
    graph,
    variant,
    onNodeSelect,
  }: {
    graph: { nodes: { id: string }[] };
    variant: string;
    onNodeSelect?: (node: unknown) => void;
  }) => (
    <div data-testid="canvas" data-variant={variant}>
      {graph.nodes.length} nodes
      {onNodeSelect &&
        graph.nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            onClick={() => onNodeSelect(node)}
          >
            select {node.id}
          </button>
        ))}
    </div>
  ),
}));

import {
  ApiError,
  getBuilderStatus,
  generateBuilderTerraform,
  createPlaygroundDraft,
  deletePlaygroundDraft,
  getPlaygroundDraft,
  listPlaygroundDrafts,
  parsePlayground,
  updatePlaygroundDraft,
} from "@/api/client";
import type {
  PlaygroundDraft,
  PlaygroundFile,
  PlaygroundSnapshot,
} from "@/api/types";
import { resetBuilderStatus } from "@/lib/use-builder-status";
import { PARSE_DEBOUNCE_MS } from "./use-playground-document";
import { PlaygroundRoutes } from "./playground-routes";

const parsePlaygroundMock = vi.mocked(parsePlayground);
const builderStatusMock = vi.mocked(getBuilderStatus);
const generateMock = vi.mocked(generateBuilderTerraform);
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

let lastPath = "";
function LocationProbe() {
  lastPath = useLocation().pathname;
  return null;
}

/**
 * The mode's own navigation is the sidebar's (GP-242), tested there. Here two
 * links stand in for it, so a test can walk between the views the way somebody
 * does — the point being that walking between them keeps the document.
 */
function renderPlayground(path = "/playground/editor") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <nav aria-label="Playground views">
        <Link to="/playground/editor">Editor</Link>
        <Link to="/playground/build">Build Editor</Link>
      </nav>
      {/* AppLayout's `<main>`, so the landmark story is the app's (GP-244). */}
      <main>
        <Routes>
          <Route path="/playground/*" element={<PlaygroundRoutes />} />
        </Routes>
      </main>
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** A file's row in the tree — its accessible name is the whole path. */
function treeFile(path: string) {
  return screen.getByRole("button", { name: path });
}

/** A file's tab, if it is open. */
function tab(path: string) {
  return screen.getByRole("button", { name: `Open ${path}` });
}

function goTo(view: "Editor" | "Build Editor") {
  fireEvent.click(
    within(
      screen.getByRole("navigation", { name: "Playground views" }),
    ).getByRole("link", { name: view }),
  );
}

beforeEach(() => {
  // The Build Editor is opt-in (GP-133): off unless a test turns it on.
  resetBuilderStatus();
  builderStatusMock.mockReset().mockResolvedValue({ enabled: false });
  generateMock.mockReset();
  parsePlaygroundMock.mockReset();
  listDraftsMock.mockReset().mockResolvedValue([]);
  getDraftMock.mockReset();
  createDraftMock.mockReset();
  updateDraftMock.mockReset();
  deleteDraftMock.mockReset();
});

// ---------------------------------------------------------------------------
// Routing (GP-244): two views, each a place you can link to.
// ---------------------------------------------------------------------------

it("sends the bare Playground URL to the Editor", async () => {
  renderPlayground("/playground");
  await waitFor(() => expect(lastPath).toBe("/playground/editor"));
  expect(screen.getByLabelText("Playground files")).toBeInTheDocument();
});

it("sends an unknown Playground route to the Editor, not out of the mode", async () => {
  renderPlayground("/playground/nonsense");
  await waitFor(() => expect(lastPath).toBe("/playground/editor"));
});

it("deep links into the Build Editor where the builder is configured", async () => {
  builderStatusMock.mockResolvedValue({ enabled: true });
  renderPlayground("/playground/build");

  expect(await screen.findByLabelText("Resource palette")).toBeInTheDocument();
  // A full view of its own, not a tab beside the editor.
  expect(screen.queryByLabelText("Playground files")).not.toBeInTheDocument();
  expect(lastPath).toBe("/playground/build");
});

it("has no Build Editor at all where the builder is not configured (GP-133)", async () => {
  renderPlayground("/playground/build");

  // Not a disabled view, not a hint: it redirects to the one that exists.
  await waitFor(() => expect(lastPath).toBe("/playground/editor"));
  expect(screen.queryByLabelText("Resource palette")).not.toBeInTheDocument();
});

it("keeps the whole document while walking between the two views", async () => {
  builderStatusMock.mockResolvedValue({ enabled: true });
  renderPlayground();

  fireEvent.change(screen.getByRole("textbox", { name: /file content/i }), {
    target: { value: "# edited here" },
  });

  goTo("Build Editor");
  fireEvent.click(
    within(await screen.findByLabelText("Resource palette")).getByRole(
      "button",
      { name: /Resource group/i },
    ),
  );
  expect(screen.getByTestId("builder-node-n1")).toBeInTheDocument();

  // Back to the Editor: the files are as they were…
  goTo("Editor");
  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: /file content/i,
  });
  expect(editor.value).toBe("# edited here");

  // …and the composition survived the trip (GP-133's acceptance criterion).
  goTo("Build Editor");
  expect(await screen.findByTestId("builder-node-n1")).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// The Editor view (GP-125..129).
// ---------------------------------------------------------------------------

it("preloads a small Azure example so the page is never empty", () => {
  renderPlayground();

  expect(treeFile("main.tf")).toBeInTheDocument();
  expect(treeFile("network.tf")).toBeInTheDocument();
  // One of them is open as a tab; the other is a click away.
  expect(tab("main.tf")).toHaveAttribute("aria-current", "true");
  expect(
    screen.queryByRole("button", { name: "Open network.tf" }),
  ).not.toBeInTheDocument();
  // The editor shows the selected file's HCL.
  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: /file content/i,
  });
  expect(editor.value).toContain("azurerm_resource_group");
});

it("Visualize parses the current files and renders the canvas", async () => {
  parsePlaygroundMock.mockResolvedValue(snap(4));
  renderPlayground();

  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));

  expect(await screen.findByTestId("canvas")).toHaveTextContent("4 nodes");
  expect(screen.getByTestId("canvas")).toHaveAttribute("data-variant", "docs");
  const sent = parsePlaygroundMock.mock.calls[0]?.[0];
  expect(sent?.map((f) => f.path)).toEqual(["main.tf", "network.tf"]);
});

it("a parse failure names the file, marks it, and keeps the last good diagram", async () => {
  parsePlaygroundMock.mockResolvedValueOnce(snap(2));
  renderPlayground();

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
  renderPlayground();

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
  renderPlayground();

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
  renderPlayground();

  openAddMenu();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /new terraform file/i }),
  );
  expect(treeFile("untitled-1.tf")).toBeInTheDocument();
  // A file you just made is a file you are about to write: it opens.
  expect(tab("untitled-1.tf")).toHaveAttribute("aria-current", "true");
});

it("deletes a file only after an inline confirmation (GP-128)", async () => {
  renderPlayground();

  openAddMenu();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /new terraform file/i }),
  );

  // Backing out of the confirmation leaves the file exactly where it was.
  fireEvent.click(screen.getByRole("button", { name: /^delete untitled-1\.tf/i }));
  fireEvent.click(screen.getByRole("button", { name: /cancel delete/i }));
  expect(treeFile("untitled-1.tf")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /^delete untitled-1\.tf/i }));
  fireEvent.click(
    screen.getByRole("button", { name: /confirm delete untitled-1\.tf/i }),
  );
  expect(
    screen.queryByRole("button", { name: "untitled-1.tf" }),
  ).not.toBeInTheDocument();
});

it("marks the files with unsaved changes, cleared by saving (GP-245)", async () => {
  createDraftMock.mockImplementation(async (input) => ({
    ...DRAFT,
    name: input.name,
    files: input.files,
  }));
  updateDraftMock.mockResolvedValue(DRAFT);
  renderPlayground();

  await saveAsDraft("my stack");
  expect(screen.queryByLabelText(/has unsaved changes/i)).not.toBeInTheDocument();

  fireEvent.change(screen.getByRole("textbox", { name: /file content/i }), {
    target: { value: "# touched" },
  });
  // The edited file is marked; the one beside it is not.
  expect(
    screen.getByLabelText("main.tf has unsaved changes"),
  ).toBeInTheDocument();
  expect(
    screen.queryByLabelText("network.tf has unsaved changes"),
  ).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /unsaved changes/i }));
  await waitFor(() =>
    expect(
      screen.queryByLabelText(/has unsaved changes/i),
    ).not.toBeInTheDocument(),
  );
});

it("identifies the selected file and follows selection", () => {
  renderPlayground();

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

it("drags the divider between the editor and the diagram (GP-245)", () => {
  renderPlayground();

  const handle = screen.getByRole("separator", { name: /resize editor/i });
  const before = Number(handle.getAttribute("aria-valuenow"));
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(Number(handle.getAttribute("aria-valuenow"))).toBe(before + 5);
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(Number(handle.getAttribute("aria-valuenow"))).toBe(before);
});

it("renames a file inline", async () => {
  renderPlayground();

  fireEvent.click(screen.getByRole("button", { name: /rename main\.tf/i }));
  const input = screen.getByRole("textbox", { name: /new name for main\.tf/i });
  fireEvent.change(input, { target: { value: "renamed.tf" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(
    await screen.findByRole("button", { name: "renamed.tf" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "main.tf" }),
  ).not.toBeInTheDocument();
  // The tab followed it: a renamed file is the same file.
  expect(tab("renamed.tf")).toBeInTheDocument();
});

it("editing the active file feeds the next parse", async () => {
  parsePlaygroundMock.mockResolvedValue(snap(1));
  renderPlayground();

  const editor = screen.getByRole("textbox", { name: /file content/i });
  fireEvent.change(editor, { target: { value: "# rewritten" } });
  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));

  await screen.findByTestId("canvas");
  const sent = parsePlaygroundMock.mock.calls[0]?.[0];
  expect(sent?.find((f) => f.path === "main.tf")?.content).toBe("# rewritten");
});

it("uploads .tf files through the file input", async () => {
  renderPlayground();

  const input = screen.getByLabelText(/upload files/i, { selector: "input" });
  const file = new File([`resource "a" "b" {}`], "uploaded.tf", {
    type: "text/plain",
  });
  fireEvent.change(input, { target: { files: [file] } });

  expect(
    await screen.findByRole("button", { name: "uploaded.tf" }),
  ).toBeInTheDocument();
});

it("has no axe violations", async () => {
  const { baseElement } = renderPlayground();
  await waitFor(async () => {
    const results = await axe(baseElement);
    expect(results.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The editor proper (GP-245): folders, tabs, a diagram that keeps up, and the
// way back from a node to the block that declares it.
// ---------------------------------------------------------------------------

it("nests a module layout under the folders its paths describe", async () => {
  renderPlayground();

  openAddMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /new folder/i }));
  // An empty folder is in the tree and nowhere else — a draft stores files.
  const folder = await screen.findByRole("button", { name: "new-folder" });
  expect(folder).toHaveAttribute("aria-expanded", "true");

  fireEvent.keyDown(
    screen.getByRole("button", { name: "Actions for new-folder" }),
    { key: "Enter" },
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /new terraform file/i }),
  );
  expect(treeFile("new-folder/untitled-1.tf")).toBeInTheDocument();
});

it("renames a folder by renaming everything under it", async () => {
  renderPlayground();

  openAddMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /new folder/i }));
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Actions for new-folder" }),
    { key: "Enter" },
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /new terraform file/i }),
  );

  fireEvent.keyDown(
    screen.getByRole("button", { name: "Actions for new-folder" }),
    { key: "Enter" },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: /rename/i }));
  const input = screen.getByRole("textbox", { name: /new name for new-folder/i });
  fireEvent.change(input, { target: { value: "modules/network" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(
    await screen.findByRole("button", { name: "modules/network/untitled-1.tf" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "new-folder/untitled-1.tf" }),
  ).not.toBeInTheDocument();
});

it("deletes a folder and what is in it, after saying so", async () => {
  renderPlayground();

  openAddMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /new folder/i }));
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Actions for new-folder" }),
    { key: "Enter" },
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: /new terraform file/i }),
  );

  fireEvent.keyDown(
    screen.getByRole("button", { name: "Actions for new-folder" }),
    { key: "Enter" },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: /delete/i }));
  expect(
    await screen.findByText(/and everything in it/),
  ).toBeInTheDocument();

  fireEvent.click(
    screen.getByRole("button", { name: "Confirm delete new-folder" }),
  );
  expect(
    screen.queryByRole("button", { name: "new-folder/untitled-1.tf" }),
  ).not.toBeInTheDocument();
});

it("opens files as tabs, and closing one keeps the file", () => {
  renderPlayground();

  // One tab to start with; opening the other from the tree adds a second.
  fireEvent.click(treeFile("network.tf"));
  expect(tab("main.tf")).not.toHaveAttribute("aria-current");
  expect(tab("network.tf")).toHaveAttribute("aria-current", "true");
  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: /file content/i,
  });
  expect(editor).toHaveAttribute("data-doc-id", "network.tf");

  fireEvent.click(screen.getByRole("button", { name: "Close network.tf" }));
  expect(
    screen.queryByRole("button", { name: "Open network.tf" }),
  ).not.toBeInTheDocument();
  // The file itself is untouched — a tab is a view of it, not the thing.
  expect(treeFile("network.tf")).toBeInTheDocument();
  expect(tab("main.tf")).toHaveAttribute("aria-current", "true");
});

it("redraws the diagram a beat after typing stops (GP-245)", async () => {
  vi.useFakeTimers();
  try {
    parsePlaygroundMock.mockResolvedValue(snap(3));
    renderPlayground();

    fireEvent.change(screen.getByRole("textbox", { name: /file content/i }), {
      target: { value: '# still typing' },
    });
    // Mid-pause: nothing has been sent anywhere.
    await act(async () => {
      vi.advanceTimersByTime(PARSE_DEBOUNCE_MS - 200);
    });
    expect(parsePlaygroundMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(parsePlaygroundMock).toHaveBeenCalledTimes(1);
    expect(parsePlaygroundMock.mock.calls[0]?.[0]?.[0]?.content).toBe(
      "# still typing",
    );
    expect(screen.getByTestId("canvas")).toHaveTextContent("3 nodes");
  } finally {
    vi.useRealTimers();
  }
});

it("does not redraw what is already on screen", async () => {
  vi.useFakeTimers();
  try {
    parsePlaygroundMock.mockResolvedValue(snap(1));
    renderPlayground();
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: /file content/i,
    });

    fireEvent.change(editor, { target: { value: "# typed" } });
    await act(async () => {
      vi.advanceTimersByTime(PARSE_DEBOUNCE_MS);
    });
    expect(parsePlaygroundMock).toHaveBeenCalledTimes(1);

    // Selecting another file, or an edit that puts the text back the way the
    // diagram already has it, is not a reason to parse anything.
    fireEvent.click(treeFile("network.tf"));
    fireEvent.click(treeFile("main.tf"));
    fireEvent.change(
      screen.getByRole("textbox", { name: /file content/i }),
      { target: { value: "# typed" } },
    );
    await act(async () => {
      vi.advanceTimersByTime(PARSE_DEBOUNCE_MS);
    });
    expect(parsePlaygroundMock).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("jumps from a node on the diagram to the block that declares it", async () => {
  const withSource = snap(1);
  withSource.graph.nodes[0] = {
    ...withSource.graph.nodes[0]!,
    source: {
      file: "network.tf",
      start_line: 6,
      end_line: 9,
      code: 'resource "azurerm_network_security_group" "app" {}',
    },
  };
  parsePlaygroundMock.mockResolvedValue(withSource);
  renderPlayground();

  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));
  fireEvent.click(await screen.findByRole("button", { name: /select n0/ }));

  // The file it was declared in is open, at its line.
  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: /file content/i,
  });
  expect(editor).toHaveAttribute("data-doc-id", "network.tf");
  expect(editor).toHaveAttribute("data-located-line", "6");
  expect(tab("network.tf")).toHaveAttribute("aria-current", "true");
});

it("does not navigate for a node the producer recorded no source for", async () => {
  parsePlaygroundMock.mockResolvedValue(snap(1));
  renderPlayground();

  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));
  fireEvent.click(await screen.findByRole("button", { name: /select n0/ }));

  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: /file content/i,
  });
  expect(editor).toHaveAttribute("data-doc-id", "main.tf");
  expect(editor).toHaveAttribute("data-located-line", "");
});

// ---------------------------------------------------------------------------
// Drafts (GP-126) through the draft-centric header (GP-129): the grouped menu,
// the editable title, the actionable save status, Ctrl+S — and the dirty guard.
// They live in the mode's shell now (GP-244), above both views.
// ---------------------------------------------------------------------------

/** Open the grouped draft menu (shows "Drafts", or the open draft's name). */
function openDraftMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: /draft actions/i }), {
    key: "Enter",
  });
}

/** Drive the Save as… flow from the menu to a created draft named `name`. */
async function saveAsDraft(name: string) {
  openDraftMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /save as/i }));
  fireEvent.change(await screen.findByLabelText(/draft name/i), {
    target: { value: name },
  });
  fireEvent.click(screen.getByRole("button", { name: /save draft/i }));
  await waitFor(() => expect(createDraftMock).toHaveBeenCalledTimes(1));
}

it("titles an unsaved playground Untitled, with the status by the actions", () => {
  renderPlayground();

  expect(
    screen.getByRole("heading", { name: /untitled/i }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /unsaved changes/i }),
  ).toBeInTheDocument();
});

it("keeps the draft header in both views", async () => {
  builderStatusMock.mockResolvedValue({ enabled: true });
  renderPlayground("/playground/build");

  await screen.findByLabelText("Resource palette");
  expect(
    screen.getByRole("heading", { name: /untitled/i }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /draft actions/i }),
  ).toBeInTheDocument();
});

it("saves as a named draft from the menu and titles the page with it", async () => {
  createDraftMock.mockImplementation(async (input) => ({
    ...DRAFT,
    name: input.name,
    files: input.files,
  }));
  renderPlayground();

  await saveAsDraft("my stack");

  const input = createDraftMock.mock.calls[0]?.[0];
  expect(input?.name).toBe("my stack");
  expect(input?.files.map((f) => f.path)).toEqual(["main.tf", "network.tf"]);
  expect(
    await screen.findByRole("heading", { name: /my stack/i }),
  ).toBeInTheDocument();
});

it("Save from the menu updates the current draft — no duplication", async () => {
  createDraftMock.mockImplementation(async (input) => ({
    ...DRAFT,
    name: input.name,
    files: input.files,
  }));
  updateDraftMock.mockResolvedValue(DRAFT);
  renderPlayground();

  await saveAsDraft("my stack");

  fireEvent.change(screen.getByRole("textbox", { name: /file content/i }), {
    target: { value: "# edited" },
  });
  openDraftMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /^save$/i }));

  await waitFor(() => expect(updateDraftMock).toHaveBeenCalledTimes(1));
  const [id, payload] = updateDraftMock.mock.calls[0] ?? [];
  expect(id).toBe("d1");
  expect(
    payload?.files?.find((f) => f.path === "main.tf")?.content,
  ).toBe("# edited");
  expect(createDraftMock).toHaveBeenCalledTimes(1);
});

it("clicking the Unsaved status starts the Save as flow", async () => {
  renderPlayground();

  fireEvent.click(screen.getByRole("button", { name: /unsaved changes/i }));
  expect(await screen.findByLabelText(/draft name/i)).toBeInTheDocument();
});

it("clicking the status with a dirty draft saves it", async () => {
  createDraftMock.mockImplementation(async (input) => ({
    ...DRAFT,
    name: input.name,
    files: input.files,
  }));
  updateDraftMock.mockResolvedValue(DRAFT);
  renderPlayground();

  await saveAsDraft("my stack");
  expect(screen.getByRole("button", { name: /^saved$/i })).toBeInTheDocument();

  fireEvent.change(screen.getByRole("textbox", { name: /file content/i }), {
    target: { value: "# edited" },
  });
  fireEvent.click(screen.getByRole("button", { name: /unsaved changes/i }));

  await waitFor(() => expect(updateDraftMock).toHaveBeenCalledTimes(1));
});

it("renames the current draft from its title, inline", async () => {
  createDraftMock.mockImplementation(async (input) => ({
    ...DRAFT,
    name: input.name,
    files: input.files,
  }));
  updateDraftMock.mockResolvedValue({ ...DRAFT, name: "renamed" });
  renderPlayground();

  await saveAsDraft("my stack");

  fireEvent.click(screen.getByRole("button", { name: "my stack" }));
  const input = screen.getByRole("textbox", { name: /rename draft/i });
  fireEvent.change(input, { target: { value: "renamed" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() =>
    expect(updateDraftMock).toHaveBeenCalledWith("d1", { name: "renamed" }),
  );
  expect(
    await screen.findByRole("heading", { name: /renamed/i }),
  ).toBeInTheDocument();
});

it("Ctrl+S saves the current draft; unsaved, it opens Save as", async () => {
  createDraftMock.mockImplementation(async (input) => ({
    ...DRAFT,
    name: input.name,
    files: input.files,
  }));
  updateDraftMock.mockResolvedValue(DRAFT);
  renderPlayground();

  // No draft yet: the shortcut opens the naming dialog.
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  expect(await screen.findByLabelText(/draft name/i)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/draft name/i), {
    target: { value: "my stack" },
  });
  fireEvent.click(screen.getByRole("button", { name: /save draft/i }));
  await waitFor(() => expect(createDraftMock).toHaveBeenCalledTimes(1));

  // With a draft open: the shortcut saves in place.
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  await waitFor(() => expect(updateDraftMock).toHaveBeenCalledTimes(1));
});

it("disables Rename and Delete in the menu until a draft is open", async () => {
  renderPlayground();

  openDraftMenu();
  expect(
    await screen.findByRole("menuitem", { name: /rename/i }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("menuitem", { name: /delete/i })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

it("deletes the current draft from the menu, behind a confirmation", async () => {
  createDraftMock.mockImplementation(async (input) => ({
    ...DRAFT,
    name: input.name,
    files: input.files,
  }));
  deleteDraftMock.mockResolvedValue(undefined);
  renderPlayground();

  await saveAsDraft("my stack");

  openDraftMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /delete/i }));
  expect(deleteDraftMock).not.toHaveBeenCalled();

  fireEvent.click(
    await screen.findByRole("button", { name: /delete draft/i }),
  );
  await waitFor(() => expect(deleteDraftMock).toHaveBeenCalledWith("d1"));
  expect(
    await screen.findByRole("heading", { name: /untitled/i }),
  ).toBeInTheDocument();
});

it("opens a draft: files restored, parse re-runs automatically", async () => {
  listDraftsMock.mockResolvedValue([DRAFT_SUMMARY]);
  getDraftMock.mockResolvedValue(DRAFT);
  parsePlaygroundMock.mockResolvedValue(snap(1));
  renderPlayground();

  openDraftMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /open draft/i }));
  fireEvent.click(
    await screen.findByRole("button", { name: /open azure sketch/i }),
  );

  expect(
    await screen.findByRole("button", { name: "saved.tf" }),
  ).toBeInTheDocument();
  await waitFor(() => expect(parsePlaygroundMock).toHaveBeenCalledTimes(1));
  expect(parsePlaygroundMock.mock.calls[0]?.[0]).toEqual(DRAFT.files);
  expect(await screen.findByTestId("canvas")).toHaveTextContent("1 nodes");
  // The opened draft's name becomes the page title (GP-129).
  expect(
    screen.getByRole("heading", { name: /azure sketch/i }),
  ).toBeInTheDocument();
});

it("a draft that no longer parses still opens, error on display", async () => {
  listDraftsMock.mockResolvedValue([DRAFT_SUMMARY]);
  getDraftMock.mockResolvedValue(DRAFT);
  parsePlaygroundMock.mockRejectedValue(
    new ApiError(422, "HCL parse failed", [
      { field: "saved.tf", message: "unbalanced braces" },
    ]),
  );
  renderPlayground();

  openDraftMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /open draft/i }));
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
  renderPlayground();

  openDraftMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /open draft/i }));
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

it("deletes a draft from the list only after confirmation", async () => {
  listDraftsMock.mockResolvedValue([DRAFT_SUMMARY]);
  deleteDraftMock.mockResolvedValue(undefined);
  renderPlayground();

  openDraftMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /open draft/i }));
  fireEvent.click(
    await screen.findByRole("button", { name: /delete azure sketch/i }),
  );
  expect(deleteDraftMock).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /delete draft/i }));
  await waitFor(() => expect(deleteDraftMock).toHaveBeenCalledWith("d1"));
});

it("warns before unload only when there are unsaved changes", () => {
  renderPlayground();

  const pristine = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(pristine);
  expect(pristine.defaultPrevented).toBe(false);

  fireEvent.change(screen.getByRole("textbox", { name: /file content/i }), {
    target: { value: "# touched" },
  });
  expect(
    screen.getByRole("button", { name: "Unsaved changes" }),
  ).toBeInTheDocument();

  const dirty = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(dirty);
  expect(dirty.defaultPrevented).toBe(true);
});

// ---------------------------------------------------------------------------
// Kubernetes: the stack switch, per-mode snapshots, and the mode-deriving
// draft open.
// ---------------------------------------------------------------------------

const K8S_DRAFT: PlaygroundDraft = {
  id: "d2",
  userId: "u1",
  name: "manifests",
  files: [
    {
      path: "app.yaml",
      content: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n",
    },
  ],
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

it("renders both switch sides; Kubernetes is disabled without .yaml files", () => {
  renderPlayground();

  const tf = screen.getByRole("button", { name: "Terraform" });
  const k8s = screen.getByRole("button", { name: "Kubernetes" });
  expect(tf).toHaveAttribute("aria-pressed", "true");
  expect(k8s).toBeDisabled();
  expect(k8s).toHaveAttribute("title", "No .yaml files");
});

it("New manifest enables the Kubernetes side; switching mutes the .tf files", async () => {
  renderPlayground();

  openAddMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /new manifest/i }));
  expect(treeFile("untitled-1.yaml")).toBeInTheDocument();

  const k8s = screen.getByRole("button", { name: "Kubernetes" });
  expect(k8s).toBeEnabled();
  fireEvent.click(k8s);
  expect(k8s).toHaveAttribute("aria-pressed", "true");
  // The .tf example files stay listed, muted as not-in-this-view.
  expect(screen.getByRole("button", { name: "main.tf" })).toHaveAttribute(
    "title",
    "Not in the Kubernetes view",
  );
});

it("Visualize sends the active iacType and keeps one snapshot per mode", async () => {
  parsePlaygroundMock.mockResolvedValue(snap(2));
  renderPlayground();

  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));
  await screen.findByTestId("canvas");
  expect(parsePlaygroundMock).toHaveBeenCalledWith(
    expect.any(Array),
    "terraform",
  );

  // A fresh manifest file, switch to Kubernetes: that mode has no snapshot yet.
  openAddMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /new manifest/i }));
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  expect(screen.queryByTestId("canvas")).not.toBeInTheDocument();

  // Flipping back shows Terraform's last render again — nothing was lost.
  fireEvent.click(screen.getByRole("button", { name: "Terraform" }));
  expect(screen.getByTestId("canvas")).toBeInTheDocument();
});

it("opening a manifests-only draft lands in Kubernetes mode and parses it as such", async () => {
  listDraftsMock.mockResolvedValue([
    { id: "d2", name: "manifests", updatedAt: K8S_DRAFT.updatedAt, fileCount: 1 },
  ]);
  getDraftMock.mockResolvedValue(K8S_DRAFT);
  parsePlaygroundMock.mockResolvedValue(snap(1));
  renderPlayground();

  openDraftMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /open draft/i }));
  fireEvent.click(await screen.findByRole("button", { name: /open manifests/i }));

  await waitFor(() =>
    expect(parsePlaygroundMock).toHaveBeenCalledWith(
      K8S_DRAFT.files,
      "kubernetes",
    ),
  );
  expect(screen.getByRole("button", { name: "Kubernetes" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

// ---------------------------------------------------------------------------
// Lenses: Global / Network / IAM on a Terraform snapshot; diagram-only for
// Kubernetes (the GP-105 rule, kept consistent).
// ---------------------------------------------------------------------------

/** A snapshot whose graph carries one role assignment, so IAM has a row. */
function iamSnap(): PlaygroundSnapshot {
  const base = snap(2);
  base.graph.nodes.push({
    id: "azurerm_role_assignment.ops",
    name: "ops",
    type: "azurerm_role_assignment",
    provider: "azurerm",
    module_path: [],
    change: null,
    privileged: true,
    role_assignment: {
      principal: "ops-team",
      role: "Owner",
      scope: "subscription",
    },
  });
  return base;
}

it("a Terraform snapshot offers Global/Network/IAM; IAM renders the table", async () => {
  parsePlaygroundMock.mockResolvedValue(iamSnap());
  renderPlayground();

  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));
  await screen.findByTestId("canvas");

  fireEvent.click(screen.getByRole("button", { name: "IAM" }));
  expect(screen.getByText("ops-team")).toBeInTheDocument();
  expect(screen.getByText("Owner")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Network" }));
  expect(screen.getByTestId("canvas")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Global" }));
  expect(screen.getByTestId("canvas")).toBeInTheDocument();
});

it("a Kubernetes snapshot gets the diagram and nothing else", async () => {
  parsePlaygroundMock.mockResolvedValue(snap(1));
  renderPlayground();

  openAddMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /new manifest/i }));
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));
  await screen.findByTestId("canvas");

  expect(
    screen.queryByRole("button", { name: "Global" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "IAM" })).not.toBeInTheDocument();
});

// --- The generate flow (GP-135) ---------------------------------------------

/** The Build Editor, with one valid resource composed. */
async function composeOneResource() {
  builderStatusMock.mockResolvedValue({ enabled: true });
  renderPlayground("/playground/build");
  fireEvent.click(
    within(await screen.findByLabelText("Resource palette")).getByRole(
      "button",
      { name: /Resource group/i },
    ),
  );
  fireEvent.change(
    within(screen.getByLabelText("Resource details")).getByLabelText(/Azure name/),
    { target: { value: "rg-demo" } },
  );
}

const GENERATED = [
  { path: "generated.tf", content: 'resource "azurerm_resource_group" "rg" {}\n' },
];

it("will not generate an incomplete composition (GP-135)", async () => {
  builderStatusMock.mockResolvedValue({ enabled: true });
  renderPlayground("/playground/build");
  fireEvent.click(
    within(await screen.findByLabelText("Resource palette")).getByRole(
      "button",
      { name: /Resource group/i },
    ),
  );

  // The resource is missing its Azure name, and the node already says so —
  // there is nothing for a round trip to the server to add.
  expect(screen.getByRole("button", { name: /Generate Terraform/ })).toBeDisabled();
  expect(generateMock).not.toHaveBeenCalled();
});

it("previews the generated files before writing them (GP-135)", async () => {
  generateMock.mockResolvedValue({ files: GENERATED });
  await composeOneResource();

  fireEvent.click(screen.getByRole("button", { name: /Generate Terraform/ }));

  await screen.findByText("Generated Terraform");
  expect(generateMock).toHaveBeenCalledWith(
    expect.objectContaining({
      nodes: [expect.objectContaining({ type: "azurerm_resource_group" })],
    }),
  );
  // Nothing has been written yet, and nothing has moved.
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.queryByRole("button", { name: "generated.tf" }),
  ).not.toBeInTheDocument();
  expect(lastPath).toBe("/playground/build");
});

it("writes the files, returns to the Editor and visualizes them (GP-135)", async () => {
  generateMock.mockResolvedValue({ files: GENERATED });
  parsePlaygroundMock.mockResolvedValue(snap(1));
  await composeOneResource();

  fireEvent.click(screen.getByRole("button", { name: /Generate Terraform/ }));
  await screen.findByText("Generated Terraform");
  fireEvent.click(screen.getByRole("button", { name: "Write to playground" }));

  // The file landed beside the others, the Editor took over, and the parse ran
  // on the merged set — the loop closes on the diagram.
  await waitFor(() => expect(parsePlaygroundMock).toHaveBeenCalled());
  expect(lastPath).toBe("/playground/editor");
  expect(
    await screen.findByRole("button", { name: "generated.tf" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Playground files")).toBeInTheDocument();
  const [written] = parsePlaygroundMock.mock.calls.at(-1) ?? [];
  expect((written as PlaygroundFile[]).map((f) => f.path)).toContain(
    "generated.tf",
  );
  // And the one-way rule is said out loud, once.
  expect(screen.getByText(/never reads Terraform back/)).toBeInTheDocument();
});

it("names the files a generation would replace, and cancels cleanly (GP-135)", async () => {
  generateMock.mockResolvedValue({
    files: [{ path: "main.tf", content: "# generated\n" }],
  });
  await composeOneResource();

  fireEvent.click(screen.getByRole("button", { name: /Generate Terraform/ }));
  await screen.findByText("Generated Terraform");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "main.tf already exists in this playground and will be replaced",
  );

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  // The example main.tf is untouched: cancelling wrote nothing.
  goTo("Editor");
  const editor = screen.getByLabelText("File content") as HTMLTextAreaElement;
  expect(editor.value).toContain('resource "azurerm_resource_group" "demo"');
  expect(editor.value).not.toContain("# generated");
});

it("badges the offending nodes when the server refuses the graph (GP-135)", async () => {
  generateMock.mockRejectedValue(
    new ApiError(422, "Validation failed", [
      {
        field: "azurerm_resource_group.resource_group.name",
        message: "Azure name is required",
        nodeId: "n1",
      },
    ]),
  );
  await composeOneResource();

  fireEvent.click(screen.getByRole("button", { name: /Generate Terraform/ }));

  await screen.findByText("Validation failed");
  // Back onto the node, not just into a sentence. Awaited because the canvas
  // holds its own copy of the nodes (so a drag does not stutter) and picks the
  // new badge up on the commit after the one that answered.
  expect(
    await screen.findByLabelText("resource_group has 1 problem"),
  ).toBeInTheDocument();
  expect(screen.queryByText("Generated Terraform")).not.toBeInTheDocument();
});
