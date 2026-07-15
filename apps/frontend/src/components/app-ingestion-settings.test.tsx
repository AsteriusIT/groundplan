import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

import {
  clearAppWebhookToken,
  getIngestionSettings,
  rotateAppWebhookToken,
} from "@/api/client";

import { AppIngestionSettings } from "./app-ingestion-settings";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    getIngestionSettings: vi.fn(),
    rotateAppWebhookToken: vi.fn(),
    clearAppWebhookToken: vi.fn(),
  };
});

const getMock = vi.mocked(getIngestionSettings);
const rotateMock = vi.mocked(rotateAppWebhookToken);
const clearMock = vi.mocked(clearAppWebhookToken);

afterEach(() => {
  vi.clearAllMocks();
});

describe("AppIngestionSettings", () => {
  it("shows 'Not set' and offers to generate a token when none exists", async () => {
    getMock.mockResolvedValue({ appWebhookTokenSet: false, updatedAt: null });
    render(<AppIngestionSettings />);

    expect(await screen.findByText("Not set")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /generate token/i }),
    ).toBeInTheDocument();
    // No revoke button when there is nothing to revoke.
    expect(screen.queryByRole("button", { name: /revoke/i })).not.toBeInTheDocument();
  });

  it("shows the freshly generated token once, then reflects 'Set'", async () => {
    getMock.mockResolvedValueOnce({ appWebhookTokenSet: false, updatedAt: null });
    rotateMock.mockResolvedValue({ webhookToken: "app-secret-123" });
    getMock.mockResolvedValueOnce({
      appWebhookTokenSet: true,
      updatedAt: "2026-07-15T00:00:00.000Z",
    });

    render(<AppIngestionSettings />);
    const generate = await screen.findByRole("button", { name: /generate token/i });

    fireEvent.click(generate);

    // The token is shown once, copyable.
    expect(await screen.findByText("app-secret-123")).toBeInTheDocument();
    // And the status flips to Set, with a Revoke affordance.
    expect(await screen.findByText("Set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /revoke/i })).toBeInTheDocument();
  });

  it("revokes the app-wide token", async () => {
    getMock.mockResolvedValueOnce({
      appWebhookTokenSet: true,
      updatedAt: "2026-07-15T00:00:00.000Z",
    });
    clearMock.mockResolvedValue(undefined);
    getMock.mockResolvedValueOnce({ appWebhookTokenSet: false, updatedAt: null });

    render(<AppIngestionSettings />);
    const revoke = await screen.findByRole("button", { name: /revoke/i });

    fireEvent.click(revoke);

    await waitFor(() => expect(clearMock).toHaveBeenCalledOnce());
    expect(await screen.findByText("Not set")).toBeInTheDocument();
  });
});
