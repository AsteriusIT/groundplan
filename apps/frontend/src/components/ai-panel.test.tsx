import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { AiPanel } from "./ai-panel";
import { resetAiStatus } from "@/lib/use-ai-status";
import { getAiStatus, getAiGeneration } from "@/api/client";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, getAiStatus: vi.fn(), getAiGeneration: vi.fn() };
});

const getAiStatusMock = vi.mocked(getAiStatus);
const getAiGenerationMock = vi.mocked(getAiGeneration);

/** Stream a plain-text body back, the way the generation route does. */
function streamingFetch(text: string) {
  return vi.fn(async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of text.split(" ")) {
          controller.enqueue(new TextEncoder().encode(`${chunk} `));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  });
}

function renderPanel(snapshotId = "snap-1") {
  return render(
    <AiPanel
      snapshotId={snapshotId}
      kind="pr_summary"
      title="AI summary"
      cta="Generate AI summary"
    />,
  );
}

beforeEach(() => {
  resetAiStatus();
  getAiStatusMock.mockResolvedValue({ enabled: true, model: "claude-opus-4-8" });
  getAiGenerationMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("renders nothing at all when the AI layer is off", async () => {
  getAiStatusMock.mockResolvedValue({ enabled: false, model: null });

  const { container } = renderPanel();

  await waitFor(() => expect(getAiStatusMock).toHaveBeenCalled());
  // Not a disabled button, not an empty card — no AI surface whatsoever.
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("does not generate on mount — the first generation is user-triggered", async () => {
  const fetchSpy = streamingFetch("Never asked for.");
  vi.stubGlobal("fetch", fetchSpy);

  renderPanel();

  const button = await screen.findByRole("button", { name: /generate ai summary/i });
  expect(button).toBeInTheDocument();
  // Mounting must never spend tokens.
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("streams a generation on click, then offers regenerate and copy", async () => {
  vi.stubGlobal("fetch", streamingFetch("**Risk:** the bucket is deleted."));
  renderPanel();

  fireEvent.click(await screen.findByRole("button", { name: /generate ai summary/i }));

  // The streamed Markdown is rendered as Markdown, not as literal asterisks.
  await waitFor(() => {
    expect(screen.getByText("Risk:")).toBeInTheDocument();
  });
  expect(screen.getByText("Risk:").tagName).toBe("STRONG");

  expect(
    await screen.findByRole("button", { name: /regenerate/i }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();

  // Always labelled as generated, always naming the model.
  expect(screen.getByText(/AI-generated from the change model/i)).toBeInTheDocument();
  expect(screen.getByText(/claude-opus-4-8/)).toBeInTheDocument();

  // The deterministic view is not replaced — the generate CTA is simply gone.
  expect(
    screen.queryByRole("button", { name: /generate ai summary/i }),
  ).not.toBeInTheDocument();
});

it("renders cached prose immediately, without calling the model", async () => {
  const fetchSpy = streamingFetch("fresh");
  vi.stubGlobal("fetch", fetchSpy);
  getAiGenerationMock.mockResolvedValue({
    kind: "pr_summary",
    targetId: "snap-1",
    model: "claude-opus-4-8",
    output: "The cached summary.",
    inputTokens: 100,
    outputTokens: 20,
    createdAt: "2026-07-13T00:00:00.000Z",
  });

  renderPanel();

  expect(await screen.findByText("The cached summary.")).toBeInTheDocument();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: /generate ai summary/i }),
  ).not.toBeInTheDocument();
});

it("regenerate asks the backend for a fresh generation", async () => {
  const fetchSpy = streamingFetch("A newer take.");
  vi.stubGlobal("fetch", fetchSpy);
  getAiGenerationMock.mockResolvedValue({
    kind: "pr_summary",
    targetId: "snap-1",
    model: "claude-opus-4-8",
    output: "The stale summary.",
    inputTokens: 100,
    outputTokens: 20,
    createdAt: "2026-07-13T00:00:00.000Z",
  });
  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: /regenerate/i }));

  await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
  const init = (fetchSpy.mock.calls as unknown as [string, RequestInit][])[0]![1];
  const body = JSON.parse(String(init.body)) as { regenerate: boolean };
  expect(body.regenerate).toBe(true);

  await waitFor(() => {
    expect(screen.getByText(/A newer take\./)).toBeInTheDocument();
  });
  expect(screen.queryByText("The stale summary.")).not.toBeInTheDocument();
});

it("switching snapshots shows that snapshot's prose, not the previous one's", async () => {
  getAiGenerationMock.mockImplementation((id: string) =>
    Promise.resolve(
      id === "snap-1"
        ? {
            kind: "pr_summary" as const,
            targetId: "snap-1",
            model: "claude-opus-4-8",
            output: "Summary of the first plan.",
            inputTokens: 1,
            outputTokens: 1,
            createdAt: "2026-07-13T00:00:00.000Z",
          }
        : null,
    ),
  );

  const { rerender } = renderPanel("snap-1");
  expect(await screen.findByText("Summary of the first plan.")).toBeInTheDocument();

  rerender(
    <AiPanel
      snapshotId="snap-2"
      kind="pr_summary"
      title="AI summary"
      cta="Generate AI summary"
    />,
  );

  // The second snapshot has none — so we offer to generate, never show the first's.
  expect(
    await screen.findByRole("button", { name: /generate ai summary/i }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Summary of the first plan.")).not.toBeInTheDocument();
});

it("surfaces a generation failure without wiping the panel", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ message: "a generation is already in progress" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: /generate ai summary/i }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/already in progress/i);
});

it("offers a full-screen read of the prose — but only once there is prose", async () => {
  getAiGenerationMock.mockResolvedValue({
    kind: "pr_summary",
    targetId: "snap-1",
    model: "claude-opus-4-8",
    output: "**Risk:** the settlement bucket is deleted.",
    inputTokens: 100,
    outputTokens: 20,
    createdAt: "2026-07-13T00:00:00.000Z",
  });

  renderPanel();

  const expand = await screen.findByRole("button", {
    name: /read ai summary full screen/i,
  });
  fireEvent.click(expand);

  // The prose is now in a dialog, rendered as Markdown and wide enough to read.
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent(/the settlement bucket is deleted/i);
  expect(within(dialog).getByText("Risk:").tagName).toBe("STRONG");
  // Still labelled, still copyable, even full screen.
  expect(within(dialog).getByText(/AI-generated from the change model/i)).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: /copy/i })).toBeInTheDocument();
});

it("shows no expand button when there is nothing to expand", async () => {
  renderPanel();

  await screen.findByRole("button", { name: /generate ai summary/i });
  expect(
    screen.queryByRole("button", { name: /full screen/i }),
  ).not.toBeInTheDocument();
});
