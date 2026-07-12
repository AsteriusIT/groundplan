import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, deleteProject: vi.fn() };
});

import { ApiError, deleteProject } from "@/api/client";
import { Button } from "@/components/ui/button";
import { DeleteProjectDialog } from "./delete-project-dialog";

const deleteProjectMock = vi.mocked(deleteProject);
const project = { id: "p1", name: "Prod Platform" };

/** Render the dialog and open it via its trigger. */
function open(onDeleted = vi.fn()) {
  render(
    <DeleteProjectDialog
      project={project}
      onDeleted={onDeleted}
      trigger={<Button>Open delete</Button>}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open delete" }));
  return { onDeleted };
}

const confirmInput = () => screen.getByLabelText(/type the project name/i);
const submitButton = () => screen.getByRole("button", { name: "Delete project" });

beforeEach(() => {
  deleteProjectMock.mockReset();
});

it("keeps the delete button disabled until the name is typed exactly", () => {
  open();
  expect(submitButton()).toBeDisabled();

  fireEvent.change(confirmInput(), { target: { value: "Prod" } });
  expect(submitButton()).toBeDisabled();

  fireEvent.change(confirmInput(), { target: { value: "Prod Platform" } });
  expect(submitButton()).toBeEnabled();
});

it("deletes the project, fires onDeleted, and closes on success", async () => {
  deleteProjectMock.mockResolvedValue(undefined);
  const { onDeleted } = open();

  fireEvent.change(confirmInput(), { target: { value: "Prod Platform" } });
  fireEvent.click(submitButton());

  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("p1"));
  expect(deleteProjectMock).toHaveBeenCalledWith("p1");
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Delete project" })).not.toBeInTheDocument(),
  );
});

it("shows the server message and does not fire onDeleted on failure", async () => {
  deleteProjectMock.mockRejectedValue(new ApiError(500, "Server exploded"));
  const { onDeleted } = open();

  fireEvent.change(confirmInput(), { target: { value: "Prod Platform" } });
  fireEvent.click(submitButton());

  expect(await screen.findByText("Server exploded")).toBeInTheDocument();
  expect(onDeleted).not.toHaveBeenCalled();
});

it("has no accessibility violations when open", async () => {
  const { baseElement } = render(
    <DeleteProjectDialog
      project={project}
      onDeleted={vi.fn()}
      trigger={<Button>Open delete</Button>}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open delete" }));
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
