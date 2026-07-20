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

it("offers SVG and PNG downloads and fetches the chosen format", async () => {
  render(<ExportMenu snapshotId="s1" filenameBase="infra-2c9f8061" />);

  fireEvent.click(screen.getByRole("menuitem", { name: /SVG/i }));

  await waitFor(() => expect(getExportMock).toHaveBeenCalledWith("s1", "svg", "full", "infra"));
  expect(URL.createObjectURL).toHaveBeenCalled();
});

it("offers network and IAM view draw.io exports", async () => {
  render(<ExportMenu snapshotId="s1" filenameBase="infra-2c9f8061" />);

  fireEvent.click(screen.getByRole("menuitem", { name: /network view/i }));
  await waitFor(() =>
    expect(getExportMock).toHaveBeenCalledWith("s1", "drawio", "full", "network"),
  );

  fireEvent.click(screen.getByRole("menuitem", { name: /IAM view/i }));
  await waitFor(() => expect(getExportMock).toHaveBeenCalledWith("s1", "drawio", "full", "iam"));
});

it("adds a changes-only PNG variant when requested", () => {
  render(<ExportMenu snapshotId="s1" filenameBase="infra" includeChangesScope />);
  expect(screen.getByRole("menuitem", { name: /changes only/i })).toBeInTheDocument();
});

it("offers a draw.io export and downloads it with the .drawio extension", async () => {
  render(<ExportMenu snapshotId="s1" filenameBase="infra-2c9f8061" />);

  fireEvent.click(screen.getByRole("menuitem", { name: /draw\.io diagram/i }));

  await waitFor(() => expect(getExportMock).toHaveBeenCalledWith("s1", "drawio", "full", "infra"));
});

it("links the downloadable draw.io shape library", () => {
  render(<ExportMenu snapshotId="s1" filenameBase="infra" />);
  const link = screen.getByRole("menuitem", { name: /shape library/i });
  expect(link).toHaveAttribute("href", "/groundplan-shapes.xml");
  expect(link).toHaveAttribute("download");
});

it("surfaces an export error", async () => {
  const { ApiError } = await import("@/api/client");
  getExportMock.mockRejectedValue(new ApiError(500, "boom"));
  render(<ExportMenu snapshotId="s1" filenameBase="infra" />);

  fireEvent.click(screen.getByRole("menuitem", { name: /PNG/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent("boom");
});
