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
import { ApiError, parseStudioFiles } from "@/api/client";

vi.mock("@/lib/use-ai-status", () => ({ useAiStatus: vi.fn() }));
const aiStatusMock = vi.mocked(useAiStatus);

// GP-142: the parse endpoint is a client call; the canvas (ELK + React Flow)
// is exercised in the canvas package — here a stub that names what it got.
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, parseStudioFiles: vi.fn() };
});
const parseMock = vi.mocked(parseStudioFiles);

vi.mock("@/components/graph-canvas", () => ({
  GraphCanvas: ({
    graph,
    highlightIds,
    lint,
  }: {
    graph: { nodes: unknown[] };
    highlightIds?: ReadonlySet<string>;
    lint?: ReadonlyMap<string, unknown[]>;
  }) => (
    <div data-testid="canvas">
      {graph.nodes.length} nodes · {highlightIds?.size ?? 0} fresh ·{" "}
      {lint?.size ?? 0} linted
    </div>
  ),
}));

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

it("a completed turn parses and renders on the canvas with lint (GP-142)", async () => {
  aiStatusMock.mockReturnValue({ enabled: true, model: "claude-opus-4-8" });
  vi.stubGlobal("fetch", sseFetch());
  parseMock.mockResolvedValue({
    snapshot: {
      version: 8,
      nodes: [
        {
          id: "azurerm_resource_group.rg",
          name: "rg",
          type: "azurerm_resource_group",
          provider: "azurerm",
          module_path: [],
          change: null,
        },
      ],
      edges: [],
    } as never,
    diagnostics: {
      parse: [],
      lint: [
        {
          ruleId: "missing-tags",
          severity: "info",
          terraformAddress: "azurerm_resource_group.rg",
          message: "This resource carries no tags.",
          fixHint: "Tag it.",
        },
      ],
    },
  });

  renderStudio();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Create a resource group with a vnet and two subnets",
    }),
  );

  // The turn's write_files set goes to the parse endpoint…
  await waitFor(() =>
    expect(parseMock).toHaveBeenCalledWith([
      { path: "main.tf", content: 'resource "azurerm_resource_group" "rg" {}\n' },
    ]),
  );
  // …and the snapshot lands on the canvas, lint riding along.
  expect((await screen.findByTestId("canvas")).textContent).toContain(
    "1 nodes · 0 fresh · 1 linted",
  );
});

it("a turn that fails to parse keeps the canvas and says why in the chat", async () => {
  aiStatusMock.mockReturnValue({ enabled: true, model: "claude-opus-4-8" });
  vi.stubGlobal("fetch", sseFetch());
  parseMock.mockRejectedValue(
    new ApiError(422, "HCL parse failed", [
      { field: "main.tf", message: "unbalanced braces" },
    ]),
  );

  renderStudio();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Create a resource group with a vnet and two subnets",
    }),
  );

  // The failure renders as a chat card naming the file; no canvas appears
  // (nothing was ever committed).
  expect(await screen.findByText("HCL parse failed")).toBeInTheDocument();
  expect(screen.getByText(/unbalanced braces/)).toBeInTheDocument();
  expect(screen.queryByTestId("canvas")).not.toBeInTheDocument();
});

it("renders no studio when the AI layer is off", () => {
  aiStatusMock.mockReturnValue({ enabled: false, model: null });
  renderStudio();
  expect(screen.getByText("AI studio is off")).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
});
