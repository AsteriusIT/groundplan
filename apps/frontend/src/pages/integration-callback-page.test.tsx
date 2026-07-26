/**
 * The provider callback page (GP-193). One page for every provider: it forwards
 * the whole query and reports what the backend made of it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { IntegrationCallbackPage } from "./integration-callback-page";
import { ApiError, completeConnection } from "@/api/client";
import type { ProviderConnection } from "@/api/types";

vi.mock("@/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/api/client")>(
    "@/api/client",
  );
  return { ...actual, completeConnection: vi.fn() };
});

vi.mock("@/org/use-org", () => ({
  useOrg: () => ({
    activeOrg: { id: "org-1", name: "Acme", slug: "acme", role: "owner" },
    singleOrg: true,
  }),
}));

const completeConnectionMock = vi.mocked(completeConnection);

const connection: ProviderConnection = {
  id: "c1",
  organizationId: "org-1",
  provider: "github",
  mode: "installation_app",
  name: "acme-corp",
  config: { installationId: 42 },
  status: "ok",
  lastError: null,
  createdAt: "2026-07-26T00:00:00.000Z",
};

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/integrations/callback${search}`]}>
      <IntegrationCallbackPage />
    </MemoryRouter>,
  );
}

describe("IntegrationCallbackPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards the state and the provider's parameters, then confirms", async () => {
    completeConnectionMock.mockResolvedValue(connection);

    renderAt("?state=sealed&installation_id=42&setup_action=install");

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(completeConnectionMock).toHaveBeenCalledWith({
      state: "sealed",
      params: { installation_id: "42", setup_action: "install" },
    });
    expect(screen.getByText(/acme-corp/)).toBeInTheDocument();
  });

  it("completes once, not twice, because a provider code is single-use", async () => {
    completeConnectionMock.mockResolvedValue(connection);

    renderAt("?state=sealed&installation_id=42");

    await screen.findByText("Connected");
    expect(completeConnectionMock).toHaveBeenCalledTimes(1);
  });

  it("reports the provider's own refusal without calling the API", async () => {
    renderAt("?error=access_denied&error_description=The+user+declined");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The user declined",
    );
    expect(completeConnectionMock).not.toHaveBeenCalled();
  });

  it("refuses a callback with no state instead of guessing", async () => {
    renderAt("?installation_id=42");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /missing its state/,
    );
    expect(completeConnectionMock).not.toHaveBeenCalled();
  });

  it("surfaces the server's message when completion fails", async () => {
    completeConnectionMock.mockRejectedValue(
      new ApiError(422, "this connection attempt is no longer valid"),
    );

    renderAt("?state=stale&installation_id=42");

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "this connection attempt is no longer valid",
      ),
    );
  });
});
