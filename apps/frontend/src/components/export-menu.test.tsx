import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, getSnapshotExport: vi.fn() };
});

import { getSnapshotExport } from "@/api/client";
import { ExportMenu } from "./export-menu";

const getExportMock = vi.mocked(getSnapshotExport);

beforeEach(() => {
  getExportMock.mockReset().mockResolvedValue(new Blob(["<svg/>"], { type: "image/svg+xml" }));
  // jsdom implements neither of these object-URL helpers.
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

function openDialog(includeChangesScope = false) {
  render(
    <ExportMenu
      snapshotId="s1"
      filenameBase="infra-2c9f8061"
      includeChangesScope={includeChangesScope}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /export/i }));
}

it("opens the export dialog and downloads the chosen format", async () => {
  openDialog();

  fireEvent.click(screen.getByRole("radio", { name: /svg/i }));
  fireEvent.click(screen.getByRole("button", { name: /download/i }));

  await waitFor(() => expect(getExportMock).toHaveBeenCalledWith("s1", "svg", "full", ["infra"]));
  expect(URL.createObjectURL).toHaveBeenCalled();
});

it("offers the changes-only PNG variant when requested", () => {
  openDialog(true);
  expect(screen.getByRole("radio", { name: /changes only/i })).toBeInTheDocument();
});

it("hides the changes-only variant by default", () => {
  openDialog();
  expect(screen.queryByRole("radio", { name: /changes only/i })).not.toBeInTheDocument();
});

it("draw.io view checkboxes pick which views become pages of one file", async () => {
  openDialog();

  fireEvent.click(screen.getByRole("radio", { name: /draw\.io/i }));
  fireEvent.click(screen.getByRole("checkbox", { name: /network/i }));
  fireEvent.click(screen.getByRole("checkbox", { name: /iam/i }));
  fireEvent.click(screen.getByRole("button", { name: /download/i }));

  await waitFor(() =>
    expect(getExportMock).toHaveBeenCalledWith("s1", "drawio", "full", [
      "infra",
      "network",
      "iam",
    ]),
  );
});

it("view checkboxes only apply to draw.io and require at least one page", () => {
  openDialog();

  // Not a draw.io export → no page checkboxes.
  expect(screen.queryByRole("checkbox", { name: /network/i })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("radio", { name: /draw\.io/i }));
  const infra = screen.getByRole("checkbox", { name: /infrastructure/i });
  expect(infra).toBeChecked();

  fireEvent.click(infra); // uncheck the only selected page
  expect(screen.getByRole("button", { name: /download/i })).toBeDisabled();
});

it("links the downloadable draw.io shape library", () => {
  openDialog();
  const link = screen.getByRole("link", { name: /shape library/i });
  expect(link).toHaveAttribute("href", "/groundplan-shapes.xml");
  expect(link).toHaveAttribute("download");
});

it("surfaces an export error", async () => {
  const { ApiError } = await import("@/api/client");
  getExportMock.mockRejectedValue(new ApiError(500, "boom"));
  openDialog();

  fireEvent.click(screen.getByRole("radio", { name: /png/i }));
  fireEvent.click(screen.getByRole("button", { name: /download/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent("boom");
});
