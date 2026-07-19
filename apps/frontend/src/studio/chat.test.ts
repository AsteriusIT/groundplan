/**
 * GP-140: the studio chat contract — prose history + current files out,
 * `write_files` tool input back in.
 */
import { expect, it } from "vitest";
import type { UIMessage } from "ai";

import {
  filesOfMessage,
  isWritingFiles,
  prepareStudioBody,
  textOfMessage,
  toStudioHistory,
} from "./chat";

const FILES = [{ path: "main.tf", content: 'resource "x" "y" {}' }];

function assistantTurn(state: string, input: unknown): UIMessage {
  return {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", text: "Done — " },
      { type: "text", text: "one resource group." },
      { type: "tool-write_files", toolCallId: "c1", state, input } as never,
    ],
  } as UIMessage;
}

it("textOfMessage joins the text parts and ignores tool parts", () => {
  expect(textOfMessage(assistantTurn("input-available", { files: FILES }))).toBe(
    "Done — one resource group.",
  );
});

it("filesOfMessage reads the completed write_files input", () => {
  const message = assistantTurn("input-available", { files: FILES });
  expect(filesOfMessage(message)).toEqual(FILES);
});

it("filesOfMessage ignores a still-streaming or malformed tool call", () => {
  expect(
    filesOfMessage(assistantTurn("input-streaming", { files: FILES })),
  ).toBeNull();
  expect(
    filesOfMessage(assistantTurn("input-available", { files: [{ nope: 1 }] })),
  ).toBeNull();
  expect(
    filesOfMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }),
  ).toBeNull();
});

it("isWritingFiles is true only while the tool input is still streaming", () => {
  expect(isWritingFiles(assistantTurn("input-streaming", undefined))).toBe(true);
  expect(isWritingFiles(assistantTurn("input-available", { files: FILES }))).toBe(
    false,
  );
  expect(
    isWritingFiles({
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    }),
  ).toBe(false);
  expect(isWritingFiles(undefined)).toBe(false);
});

it("toStudioHistory flattens messages to prose turns and drops empty ones", () => {
  const messages: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "make a vnet" }] },
    assistantTurn("input-available", { files: FILES }),
    // A turn that produced only a tool call (no prose) sends nothing to say.
    {
      id: "a2",
      role: "assistant",
      parts: [
        { type: "tool-write_files", toolCallId: "c2", state: "input-available", input: { files: FILES } } as never,
      ],
    } as UIMessage,
  ];
  expect(toStudioHistory(messages)).toEqual([
    { role: "user", text: "make a vnet" },
    { role: "assistant", text: "Done — one resource group." },
  ]);
});

it("prepareStudioBody sends the files only when the session has some", () => {
  const messages: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "make a vnet" }] },
  ];
  expect(prepareStudioBody(messages, [])).toEqual({
    messages: [{ role: "user", text: "make a vnet" }],
  });
  expect(prepareStudioBody(messages, FILES)).toEqual({
    messages: [{ role: "user", text: "make a vnet" }],
    files: FILES,
  });
});
