import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    parsePlayground: vi.fn(),
    getBuilderStatus: vi.fn(),
    listPlaygroundDrafts: vi.fn(),
  };
});

vi.mock("@/components/hcl-editor", () => ({
  HclEditor: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (content: string) => void;
    ariaLabel: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock("@/components/graph-canvas", () => ({
  GraphCanvas: () => <div data-testid="canvas" />,
}));

import { getBuilderStatus, parsePlayground } from "@/api/client";
import { resetBuilderStatus } from "@/lib/use-builder-status";
import {
  LAYOUT_STORAGE_KEY,
  SPLIT_STORAGE_KEY,
} from "./editor-layout";
import { PlaygroundRoutes } from "./playground-routes";

function renderEditor() {
  return render(
    <MemoryRouter initialEntries={["/playground/editor"]}>
      <main>
        <Routes>
          <Route path="/playground/*" element={<PlaygroundRoutes />} />
        </Routes>
      </main>
    </MemoryRouter>,
  );
}

const layout = (name: "Editor" | "Split" | "Preview") =>
  screen.getByRole("button", { name });

beforeEach(() => {
  localStorage.clear();
  resetBuilderStatus();
  vi.mocked(getBuilderStatus).mockResolvedValue({ enabled: false });
  vi.mocked(parsePlayground).mockReset();
});

it("offers three layouts from one control, saying which is current", () => {
  renderEditor();

  // Split is where it starts: both halves of the job at once.
  expect(layout("Split")).toHaveAttribute("aria-pressed", "true");
  expect(layout("Editor")).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("textbox", { name: /file content/i })).toBeVisible();
  expect(screen.getByLabelText("Diagram")).toBeVisible();

  // Hidden, not unmounted: what is on screen changes, what is in hand does not.
  fireEvent.click(layout("Editor"));
  expect(screen.getByLabelText("Diagram")).not.toBeVisible();
  expect(screen.getByRole("textbox", { name: /file content/i })).toBeVisible();

  fireEvent.click(layout("Preview"));
  expect(screen.getByLabelText("Diagram")).toBeVisible();
  expect(
    screen.queryByRole("textbox", { name: /file content/i }),
  ).not.toBeInTheDocument();
});

it("loses no unsaved edit, and no open tab, on the way through Preview", () => {
  renderEditor();

  fireEvent.click(screen.getByRole("button", { name: "network.tf" }));
  fireEvent.change(screen.getByRole("textbox", { name: /file content/i }), {
    target: { value: "# half a thought" },
  });

  fireEvent.click(layout("Preview"));
  fireEvent.click(layout("Split"));

  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: /file content/i,
  });
  expect(editor.value).toBe("# half a thought");
  expect(
    screen.getByRole("button", { name: "Open network.tf" }),
  ).toHaveAttribute("aria-current", "true");
});

it("cycles the layouts from the keyboard", () => {
  renderEditor();

  fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true });
  expect(layout("Preview")).toHaveAttribute("aria-pressed", "true");
  fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true });
  expect(layout("Editor")).toHaveAttribute("aria-pressed", "true");

  // Not while somebody is typing: Alt+L in a file is a letter.
  fireEvent.keyDown(screen.getByRole("textbox", { name: /file content/i }), {
    key: "l",
    ctrlKey: true,
    altKey: true,
  });
  expect(layout("Editor")).toHaveAttribute("aria-pressed", "true");
});

it("remembers the layout and the divider across a remount", () => {
  const { unmount } = renderEditor();

  const handle = screen.getByRole("separator", { name: /resize editor/i });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  const ratio = handle.getAttribute("aria-valuenow");
  fireEvent.click(layout("Preview"));

  expect(localStorage.getItem(LAYOUT_STORAGE_KEY)).toBe("preview");
  expect(localStorage.getItem(SPLIT_STORAGE_KEY)).toBe(ratio);

  unmount();
  renderEditor();
  expect(layout("Preview")).toHaveAttribute("aria-pressed", "true");
  // And coming back to Split finds the divider where it was left.
  fireEvent.click(layout("Split"));
  expect(
    screen.getByRole("separator", { name: /resize editor/i }),
  ).toHaveAttribute("aria-valuenow", ratio);
});

it("keeps the divider out of the way when there is nothing to divide", () => {
  renderEditor();
  fireEvent.click(layout("Editor"));
  expect(
    screen.queryByRole("separator", { name: /resize editor/i }),
  ).not.toBeInTheDocument();
});
