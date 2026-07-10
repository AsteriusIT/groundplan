import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, listProjects: vi.fn(), createProject: vi.fn() };
});

import { ApiError, createProject, listProjects } from "@/api/client";
import type { Project } from "@/api/types";
import { ProjectsPage } from "./projects-page";

const listProjectsMock = vi.mocked(listProjects);
const createProjectMock = vi.mocked(createProject);

function project(over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Prod",
    slug: "prod",
    createdAt: "2026-01-02T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  listProjectsMock.mockReset();
  createProjectMock.mockReset();
});

it("shows a loading state", () => {
  listProjectsMock.mockReturnValue(new Promise<Project[]>(() => {}));
  render(<ProjectsPage />);
  expect(screen.getByText("Loading projects…")).toBeInTheDocument();
});

it("shows the empty state with a create action", async () => {
  listProjectsMock.mockResolvedValue([]);
  render(<ProjectsPage />);
  expect(await screen.findByText("No projects yet")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /create your first project/i }),
  ).toBeInTheDocument();
});

it("renders the project list", async () => {
  listProjectsMock.mockResolvedValue([
    project({ id: "1", name: "Alpha", slug: "alpha" }),
    project({ id: "2", name: "Beta", slug: "beta" }),
  ]);
  render(<ProjectsPage />);
  expect(await screen.findByText("Alpha")).toBeInTheDocument();
  expect(screen.getByText("Beta")).toBeInTheDocument();
  expect(screen.getByText("alpha")).toBeInTheDocument();
});

it("shows an error state with the server message, then retries", async () => {
  listProjectsMock.mockRejectedValueOnce(new ApiError(500, "Server exploded"));
  render(<ProjectsPage />);
  expect(await screen.findByText("Server exploded")).toBeInTheDocument();
  expect(screen.getByRole("alert")).toBeInTheDocument();

  listProjectsMock.mockResolvedValueOnce([project({ name: "Recovered" })]);
  fireEvent.click(screen.getByRole("button", { name: /try again/i }));
  expect(await screen.findByText("Recovered")).toBeInTheDocument();
});

it("adds a created project to the list without refetching", async () => {
  listProjectsMock.mockResolvedValue([]);
  createProjectMock.mockResolvedValue(
    project({ id: "new", name: "Fresh Estate", slug: "fresh-estate" }),
  );
  render(<ProjectsPage />);

  fireEvent.click(
    await screen.findByRole("button", { name: /create your first project/i }),
  );
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: "Fresh Estate" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^create project$/i }));

  expect(await screen.findByText("Fresh Estate")).toBeInTheDocument();
  expect(createProjectMock).toHaveBeenCalledWith({
    name: "Fresh Estate",
    slug: "fresh-estate",
  });
  expect(listProjectsMock).toHaveBeenCalledTimes(1); // no reload/refetch
});

it("has no accessibility violations in the list state", async () => {
  listProjectsMock.mockResolvedValue([project({ name: "Alpha", slug: "alpha" })]);
  const { container } = render(
    <main>
      <ProjectsPage />
    </main>,
  );
  await screen.findByText("Alpha");
  const results = await axe(container);
  expect(results.violations).toEqual([]);
});
