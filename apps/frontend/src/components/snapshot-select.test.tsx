import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

import type { SnapshotSummary } from "@/api/types";
import { SnapshotSelect } from "./snapshot-select";

function summary(
  id: string,
  commitSha: string,
  trigger: "manual" | "auto",
): SnapshotSummary {
  return {
    id,
    repositoryId: "r1",
    clusterId: null,
    namespace: null,
    source: "hcl",
    ref: "main",
    commitSha,
    prNumber: null,
    createdAt: "2026-01-03T00:00:00.000Z",
    stats: {
      nodes: 1,
      edges: 0,
      changes: { create: 0, update: 0, delete: 0, noop: 0, unchanged: 1 },
      trigger,
    },
  };
}

const snaps = [
  summary("s3", "cccccccc3333", "auto"),
  summary("s2", "bbbbbbbb2222", "manual"),
  summary("s1", "aaaaaaaa1111", "manual"),
];

function noop() {}

it("shows the selected snapshot in the trigger and lists all snapshots as menu items", () => {
  render(
    <SnapshotSelect
      snapshots={snaps}
      selectedIds={["s3"]}
      visible={10}
      compareMode={false}
      onSelect={noop}
      onShowMore={noop}
    />,
  );

  // Trigger summarises the selected snapshot (sha · TRIGGER · date) in one node.
  expect(screen.getByText(/cccccccc.*AUTO/i)).toBeInTheDocument();

  // Every snapshot is a menu item (role query does not match the trigger summary).
  expect(screen.getByRole("menuitem", { name: /cccccccc/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /bbbbbbbb/i })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: /aaaaaaaa/i })).toBeInTheDocument();
});

it("calls onSelect with the snapshot id when a row is clicked", () => {
  const onSelect = vi.fn();
  render(
    <SnapshotSelect
      snapshots={snaps}
      selectedIds={["s3"]}
      visible={10}
      compareMode={false}
      onSelect={onSelect}
      onShowMore={noop}
    />,
  );

  fireEvent.click(screen.getByRole("menuitem", { name: /aaaaaaaa/i }));
  expect(onSelect).toHaveBeenCalledWith("s1");
});

it("renders checkbox rows reflecting the picked pair in compare mode", () => {
  const onSelect = vi.fn();
  render(
    <SnapshotSelect
      snapshots={snaps}
      selectedIds={["s2"]}
      visible={10}
      compareMode={true}
      onSelect={onSelect}
      onShowMore={noop}
    />,
  );

  const picked = screen.getByRole("menuitemcheckbox", { name: /bbbbbbbb/i });
  expect(picked).toHaveAttribute("aria-checked", "true");
  expect(
    screen.getByRole("menuitemcheckbox", { name: /aaaaaaaa/i }),
  ).toHaveAttribute("aria-checked", "false");

  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /aaaaaaaa/i }));
  expect(onSelect).toHaveBeenCalledWith("s1");
});

it("paginates with a Show more control", () => {
  const onShowMore = vi.fn();
  render(
    <SnapshotSelect
      snapshots={snaps}
      selectedIds={["s3"]}
      visible={2}
      compareMode={false}
      onSelect={noop}
      onShowMore={onShowMore}
    />,
  );

  expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: /show more/i }));
  expect(onShowMore).toHaveBeenCalled();
});

it("has no accessibility violations", async () => {
  const { baseElement } = render(
    <SnapshotSelect
      snapshots={snaps}
      selectedIds={["s3"]}
      visible={10}
      compareMode={false}
      onSelect={noop}
      onShowMore={noop}
    />,
  );
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});

it("closes the panel after selecting in single mode", () => {
  render(
    <SnapshotSelect
      snapshots={snaps}
      selectedIds={["s3"]}
      visible={10}
      compareMode={false}
      onSelect={noop}
      onShowMore={noop}
    />,
  );
  const details = screen.getByText("History").closest("details") as HTMLDetailsElement;

  // Open the panel, then pick a snapshot — single-select closes it.
  fireEvent.click(screen.getByText("History"));
  expect(details.open).toBe(true);

  fireEvent.click(screen.getByRole("menuitem", { name: /aaaaaaaa/i }));
  expect(details.open).toBe(false);
});

it("keeps the panel open after a pick in compare mode", () => {
  render(
    <SnapshotSelect
      snapshots={snaps}
      selectedIds={["s2"]}
      visible={10}
      compareMode={true}
      onSelect={noop}
      onShowMore={noop}
    />,
  );
  const details = screen.getByText("History").closest("details") as HTMLDetailsElement;

  // Open the panel, then pick — compare mode's two-pick must stay open.
  fireEvent.click(screen.getByText("History"));
  expect(details.open).toBe(true);

  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /aaaaaaaa/i }));
  expect(details.open).toBe(true);
});
