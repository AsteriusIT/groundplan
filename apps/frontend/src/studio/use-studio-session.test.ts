/**
 * GP-142: the session's commit rule — a turn's files commit only when they
 * parse; a failure keeps the last good snapshot and says why in the chat.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { ApiError, parseStudioFiles } from "@/api/client";
import type { Graph } from "@/api/types";
import { useStudioSession } from "./use-studio-session";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, parseStudioFiles: vi.fn() };
});
const parseMock = vi.mocked(parseStudioFiles);

const FILES_V1 = [{ path: "main.tf", content: "v1" }];
const FILES_V2 = [{ path: "main.tf", content: "v2" }];

function graphOf(ids: string[]): Graph {
  return {
    version: 8,
    nodes: ids.map((id) => ({
      id,
      name: id.split(".")[1] ?? id,
      type: id.split(".")[0] ?? id,
      provider: "azurerm",
      module_path: [],
      change: null,
    })),
    edges: [],
  } as unknown as Graph;
}

const LINT = [
  {
    ruleId: "missing-tags",
    severity: "info" as const,
    terraformAddress: "azurerm_resource_group.rg",
    message: "This resource carries no tags.",
    fixHint: "Tag it.",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

it("commitTurn parses and commits: snapshot, files, lint by node", async () => {
  parseMock.mockResolvedValue({
    snapshot: graphOf(["azurerm_resource_group.rg"]),
    diagnostics: { parse: [], lint: LINT },
  });
  const { result } = renderHook(() => useStudioSession());

  await act(() => result.current.commitTurn(FILES_V1));

  expect(result.current.files).toEqual(FILES_V1);
  expect(result.current.filesRef()).toEqual(FILES_V1);
  expect(result.current.snapshot?.nodes).toHaveLength(1);
  expect(
    result.current.lint.get("azurerm_resource_group.rg"),
  ).toEqual(LINT);
  expect(result.current.parseFailure).toBeNull();
  expect(result.current.hasWork).toBe(true);
  // The first snapshot is not "new since last turn" — there was no last turn.
  expect(result.current.freshNodeIds.size).toBe(0);
});

it("a later turn marks only the nodes it introduced as fresh", async () => {
  parseMock.mockResolvedValueOnce({
    snapshot: graphOf(["azurerm_resource_group.rg"]),
    diagnostics: { parse: [], lint: [] },
  });
  parseMock.mockResolvedValueOnce({
    snapshot: graphOf(["azurerm_resource_group.rg", "azurerm_storage_account.sa"]),
    diagnostics: { parse: [], lint: [] },
  });
  const { result } = renderHook(() => useStudioSession());

  await act(() => result.current.commitTurn(FILES_V1));
  await act(() => result.current.commitTurn(FILES_V2));

  expect([...result.current.freshNodeIds]).toEqual([
    "azurerm_storage_account.sa",
  ]);
});

it("a parse failure keeps the last good state and reports the reason", async () => {
  parseMock.mockResolvedValueOnce({
    snapshot: graphOf(["azurerm_resource_group.rg"]),
    diagnostics: { parse: [], lint: [] },
  });
  parseMock.mockRejectedValueOnce(
    new ApiError(422, "HCL parse failed", [
      { field: "main.tf", message: "unbalanced braces" },
    ]),
  );
  const { result } = renderHook(() => useStudioSession());

  await act(() => result.current.commitTurn(FILES_V1));
  await act(() => result.current.commitTurn(FILES_V2));

  // Nothing moved: the canvas still shows v1, and v1 is what the next turn
  // regenerates from.
  expect(result.current.files).toEqual(FILES_V1);
  expect(result.current.filesRef()).toEqual(FILES_V1);
  expect(result.current.snapshot?.nodes).toHaveLength(1);
  expect(result.current.parseFailure?.message).toBe("HCL parse failed");
  expect(result.current.parseFailure?.diagnostics).toEqual([
    { severity: "error", file: "main.tf", message: "unbalanced braces" },
  ]);
});

it("a partially valid turn commits, with the failures still reported", async () => {
  parseMock.mockResolvedValue({
    snapshot: graphOf(["azurerm_resource_group.rg"]),
    diagnostics: {
      parse: [
        { severity: "error", file: "broken.tf", message: "unbalanced braces" },
      ],
      lint: [],
    },
  });
  const { result } = renderHook(() => useStudioSession());
  await act(() => result.current.commitTurn(FILES_V1));

  expect(result.current.files).toEqual(FILES_V1);
  expect(result.current.parseFailure?.diagnostics[0]?.file).toBe("broken.tf");
});

it("reset clears everything", async () => {
  parseMock.mockResolvedValue({
    snapshot: graphOf(["azurerm_resource_group.rg"]),
    diagnostics: { parse: [], lint: LINT },
  });
  const { result } = renderHook(() => useStudioSession());
  await act(() => result.current.commitTurn(FILES_V1));

  act(() => result.current.reset());
  expect(result.current.files).toEqual([]);
  expect(result.current.snapshot).toBeNull();
  expect(result.current.lint.size).toBe(0);
  expect(result.current.hasWork).toBe(false);
});
