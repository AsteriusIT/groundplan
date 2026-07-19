import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { Annotation } from "../types";
import { NotePanel } from "./note-editor";

function note(id: string, body: string): Annotation {
  return {
    id,
    repositoryId: "r",
    type: "note",
    anchors: ["aws_s3_bucket.a"],
    label: null,
    body,
    status: "resolved",
    provenance: "human" as const,
    reason: null,
    createdFromSha: null,
    parentGroupId: null,
    missingAnchors: [],
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const noop = () => {};

it("renders existing note bodies", () => {
  render(
    <NotePanel
      notes={[note("n1", "owned by **payments**")]}
      onCreate={noop}
      onUpdate={noop}
      onDelete={noop}
    />,
  );
  expect(screen.getByText(/owned by/)).toBeInTheDocument();
});

it("adds a note via the editor", () => {
  const onCreate = vi.fn();
  render(<NotePanel notes={[]} onCreate={onCreate} onUpdate={noop} onDelete={noop} />);
  fireEvent.change(screen.getByLabelText("New note"), {
    target: { value: "runs the billing job" },
  });
  fireEvent.click(screen.getByRole("button", { name: /add note/i }));
  expect(onCreate).toHaveBeenCalledWith("runs the billing job");
});

it("edits an existing note", () => {
  const onUpdate = vi.fn();
  render(
    <NotePanel notes={[note("n1", "before")]} onCreate={noop} onUpdate={onUpdate} onDelete={noop} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /edit note/i }));
  fireEvent.change(screen.getByLabelText("Edit note"), { target: { value: "after" } });
  fireEvent.click(screen.getByRole("button", { name: /save note/i }));
  expect(onUpdate).toHaveBeenCalledWith("n1", "after");
});

it("deletes a note", () => {
  const onDelete = vi.fn();
  render(
    <NotePanel notes={[note("n1", "x")]} onCreate={noop} onUpdate={noop} onDelete={onDelete} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /delete note/i }));
  expect(onDelete).toHaveBeenCalledWith("n1");
});

it("is read-only when readOnly: no add/edit/delete controls", () => {
  render(
    <NotePanel
      notes={[note("n1", "x")]}
      readOnly
      onCreate={noop}
      onUpdate={noop}
      onDelete={noop}
    />,
  );
  expect(screen.queryByLabelText("New note")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /edit note/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /delete note/i })).not.toBeInTheDocument();
});
