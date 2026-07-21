import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getConfluenceConnection: vi.fn(),
    publishToConfluence: vi.fn(),
  };
});

import { getConfluenceConnection, publishToConfluence } from "@/api/client";
import type { ConfluenceConnection } from "@/api/types";
import { ConfluencePublish } from "./confluence-publish";

const getMock = vi.mocked(getConfluenceConnection);
const publishMock = vi.mocked(publishToConfluence);

const connection: ConfluenceConnection = {
  id: "c1",
  repositoryId: "r1",
  integrationId: "i1",
  spaceKey: "DOCS",
  pageUrl: null,
  lastPublishedAt: null,
  lastPublishError: null,
  createdAt: "2026-07-01T00:00:00Z",
};

beforeEach(() => {
  getMock.mockReset();
  publishMock.mockReset();
});

it("renders nothing when no Confluence target is configured", async () => {
  getMock.mockResolvedValue(null);
  const { container } = render(<ConfluencePublish repositoryId="r1" />);
  await vi.waitFor(() => expect(getMock).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

it("publishes and shows the page link with the publish time", async () => {
  getMock.mockResolvedValue(connection);
  publishMock.mockResolvedValue({
    ok: true,
    pageUrl: "https://acme.atlassian.net/wiki/pages/42",
    publishedAt: new Date().toISOString(),
  });
  render(<ConfluencePublish repositoryId="r1" />);

  fireEvent.click(await screen.findByRole("button", { name: /publish/i }));
  expect(publishMock).toHaveBeenCalledWith("r1");

  const link = await screen.findByRole("link", { name: /published/i });
  expect(link).toHaveAttribute(
    "href",
    "https://acme.atlassian.net/wiki/pages/42",
  );
});

it("a previously published page is linked before any new publish", async () => {
  getMock.mockResolvedValue({
    ...connection,
    pageUrl: "https://acme.atlassian.net/wiki/pages/41",
    lastPublishedAt: "2026-07-20T09:00:00Z",
  });
  render(<ConfluencePublish repositoryId="r1" />);

  const link = await screen.findByRole("link", { name: /published/i });
  expect(link).toHaveAttribute(
    "href",
    "https://acme.atlassian.net/wiki/pages/41",
  );
});

it("a categorized failure is readable by a non-dev", async () => {
  getMock.mockResolvedValue(connection);
  publishMock.mockResolvedValue({ ok: false, error: "network" });
  render(<ConfluencePublish repositoryId="r1" />);

  fireEvent.click(await screen.findByRole("button", { name: /publish/i }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toMatch(/could not reach the confluence site/i);
});

it("has no axe violations", async () => {
  getMock.mockResolvedValue({
    ...connection,
    pageUrl: "https://acme.atlassian.net/wiki/pages/41",
    lastPublishedAt: "2026-07-20T09:00:00Z",
  });
  const { baseElement } = render(
    <main>
      <ConfluencePublish repositoryId="r1" />
    </main>,
  );
  await screen.findByRole("button", { name: /publish/i });
  const results = await axe(baseElement);
  expect(results.violations).toEqual([]);
});
