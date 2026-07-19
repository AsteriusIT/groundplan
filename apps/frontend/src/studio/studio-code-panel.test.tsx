/**
 * GP-143: the code panel — tree + viewer + node→code jump + download.
 */
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { StudioCodePanel } from "./studio-code-panel";
import { buildStudioZip } from "@/lib/studio-zip";

vi.mock("@/lib/studio-zip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/studio-zip")>();
  return { ...actual, buildStudioZip: vi.fn() };
});
const zipMock = vi.mocked(buildStudioZip);

const FILES = [
  {
    path: "main.tf",
    content:
      'resource "azurerm_resource_group" "rg" {\n  name = "demo"\n}\n',
  },
  {
    path: "network.tf",
    content: 'resource "azurerm_virtual_network" "vnet" {\n}\n',
  },
];

afterEach(() => {
  vi.clearAllMocks();
});

it("lists every file and renders the first with HCL highlighting", () => {
  render(<StudioCodePanel files={FILES} target={null} />);
  expect(screen.getByRole("button", { name: /main\.tf/ })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /network\.tf/ }),
  ).toBeInTheDocument();
  // main.tf is shown by default; its resource name renders as a string token.
  expect(screen.getByText('"demo"')).toBeInTheDocument();
  // The "how to use this" hint.
  expect(screen.getByText(/terraform init && terraform plan/)).toBeInTheDocument();
});

it("switching files swaps the content", () => {
  render(<StudioCodePanel files={FILES} target={null} />);
  fireEvent.click(screen.getByRole("button", { name: /network\.tf/ }));
  expect(screen.getByText('"vnet"')).toBeInTheDocument();
  expect(screen.queryByText('"demo"')).not.toBeInTheDocument();
});

it("a node→code target opens the file and marks the block", () => {
  render(
    <StudioCodePanel
      files={FILES}
      target={{ file: "main.tf", range: { start: 1, end: 3 } }}
    />,
  );
  expect(screen.getByText('"demo"')).toBeInTheDocument();
  expect(document.querySelectorAll(".bg-impacted-soft")).toHaveLength(3);
});

it("a later manual pick beats the old target", () => {
  const target = { file: "main.tf", range: { start: 1, end: 3 } };
  const { rerender } = render(
    <StudioCodePanel files={FILES} target={target} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /network\.tf/ }));
  // Re-render with the *same* target — no new jump, so the pick stands.
  rerender(<StudioCodePanel files={FILES} target={target} />);
  expect(screen.getByText('"vnet"')).toBeInTheDocument();
});

it("Download zips the current file set", async () => {
  zipMock.mockResolvedValue(new Blob(["zip"]));
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:studio"),
    revokeObjectURL: vi.fn(),
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});

  render(<StudioCodePanel files={FILES} target={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Download zip" }));

  await waitFor(() => expect(zipMock).toHaveBeenCalledWith(FILES));
  expect(click).toHaveBeenCalled();

  click.mockRestore();
  vi.unstubAllGlobals();
});
