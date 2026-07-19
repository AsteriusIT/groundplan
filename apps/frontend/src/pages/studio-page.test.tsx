/**
 * GP-141: the AI-mode shell — empty state with suggestions, streaming into a
 * docked chat + canvas region, the exit guard, and the AI-off gate. The chat
 * endpoint is a mocked fetch replaying the exact SSE the backend emits.
 */
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { StudioPage } from "./studio-page";
import { useAiStatus } from "@/lib/use-ai-status";

vi.mock("@/lib/use-ai-status", () => ({ useAiStatus: vi.fn() }));
const aiStatusMock = vi.mocked(useAiStatus);

/** The chat endpoint's wire format, verbatim (captured from the backend). */
const SSE_BODY = [
  `data: {"type":"start"}`,
  `data: {"type":"start-step"}`,
  `data: {"type":"text-start","id":"t1"}`,
  `data: {"type":"text-delta","id":"t1","delta":"Created a resource group."}`,
  `data: {"type":"text-end","id":"t1"}`,
  `data: {"type":"tool-input-available","toolCallId":"call-1","toolName":"write_files","input":{"files":[{"path":"main.tf","content":"resource \\"azurerm_resource_group\\" \\"rg\\" {}\\n"}]}}`,
  `data: {"type":"finish-step"}`,
  `data: {"type":"finish","finishReason":"tool-calls"}`,
  `data: [DONE]`,
  "",
].join("\n\n");

function sseFetch() {
  return vi.fn(async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(SSE_BODY));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
}

function renderStudio() {
  return render(
    <MemoryRouter initialEntries={["/studio"]}>
      <Routes>
        <Route path="/studio" element={<StudioPage />} />
        <Route path="/dashboard" element={<p>dashboard page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("streams a turn: suggestion chip → docked chat + canvas region", async () => {
  aiStatusMock.mockReturnValue({ enabled: true, model: "claude-opus-4-8" });
  const fetchMock = sseFetch();
  vi.stubGlobal("fetch", fetchMock);

  renderStudio();

  // Empty state: centered chat with the example prompts.
  const chip = screen.getByRole("button", {
    name: "Create a resource group with a vnet and two subnets",
  });
  fireEvent.click(chip);

  // The turn hits the chat endpoint with the studio body shape.
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  const [url, init] = fetchMock.mock.calls[0]!  as unknown as [string, RequestInit];
  expect(url).toBe("/api/v1/ai-studio/chat");
  const body = JSON.parse(init.body as string);
  expect(body.messages).toEqual([
    {
      role: "user",
      text: "Create a resource group with a vnet and two subnets",
    },
  ]);

  // Streaming lands: the chat docks and the assistant prose renders.
  await screen.findByText("Created a resource group.");
  expect(
    screen.getByRole("region", { name: "Studio chat" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Studio diagram" }),
  ).toBeInTheDocument();
});

it("Esc with a live session asks before leaving; Leave exits", async () => {
  aiStatusMock.mockReturnValue({ enabled: true, model: "claude-opus-4-8" });
  vi.stubGlobal("fetch", sseFetch());

  renderStudio();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Create a resource group with a vnet and two subnets",
    }),
  );
  await screen.findByText("Created a resource group.");

  fireEvent.keyDown(window, { key: "Escape" });
  expect(await screen.findByText("Leave AI studio?")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Leave" }));
  expect(await screen.findByText("dashboard page")).toBeInTheDocument();
});

it("without a session, Esc exits straight away", async () => {
  aiStatusMock.mockReturnValue({ enabled: true, model: "claude-opus-4-8" });
  renderStudio();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(await screen.findByText("dashboard page")).toBeInTheDocument();
});

it("renders no studio when the AI layer is off", () => {
  aiStatusMock.mockReturnValue({ enabled: false, model: null });
  renderStudio();
  expect(screen.getByText("AI studio is off")).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
});
