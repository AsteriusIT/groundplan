/**
 * GP-140: the studio's wiring between `useChat` and the GP-137 endpoint.
 *
 * The server speaks the AI SDK UI-message protocol but owns none of the
 * session: every request re-sends the prose history plus the current file
 * set, and every assistant turn carries the complete regenerated project in
 * a `write_files` tool part. These helpers are that contract, in one place.
 */
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  type UIMessage,
} from "ai";

import { streamingEndpoint } from "@/api/client";

/** One in-memory `.tf` file of the studio session. */
export type StudioFile = { path: string; content: string };

/** One prose turn of the history the server expects. */
export type StudioChatMessage = { role: "user" | "assistant"; text: string };

/** The visible prose of a message — its text parts, nothing else. */
export function textOfMessage(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function isStudioFile(value: unknown): value is StudioFile {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as StudioFile).path === "string" &&
    typeof (value as StudioFile).content === "string"
  );
}

/**
 * The complete regenerated project of an assistant turn: the input of its
 * last completed `write_files` tool call, or null when the turn carried none
 * (an error, or an answer that changed nothing it wanted to say in files).
 */
export function filesOfMessage(message: UIMessage): StudioFile[] | null {
  for (const part of [...message.parts].reverse()) {
    if (!isToolUIPart(part) || getToolName(part) !== "write_files") continue;
    if (part.state !== "input-available" && part.state !== "output-available") {
      continue;
    }
    const files = (part.input as { files?: unknown } | undefined)?.files;
    if (Array.isArray(files) && files.every(isStudioFile)) return files;
  }
  return null;
}

/**
 * True while the assistant is still streaming the `write_files` tool input —
 * the (long) gap between the prose saying "done" and the files actually
 * having arrived. The UI owes the user a progress line for exactly this span.
 */
export function isWritingFiles(message: UIMessage | undefined): boolean {
  if (message?.role !== "assistant") return false;
  return message.parts.some(
    (part) =>
      isToolUIPart(part) &&
      getToolName(part) === "write_files" &&
      part.state === "input-streaming",
  );
}

/** UI messages → the prose-only history the chat endpoint expects. */
export function toStudioHistory(messages: UIMessage[]): StudioChatMessage[] {
  return messages
    .filter((m): m is UIMessage & { role: "user" | "assistant" } =>
      m.role === "user" || m.role === "assistant",
    )
    .map((m) => ({ role: m.role, text: textOfMessage(m) }))
    .filter((m) => m.text.trim() !== "");
}

/** The request body of one turn — pure, so the contract is testable. */
export function prepareStudioBody(
  messages: UIMessage[],
  files: StudioFile[],
): { messages: StudioChatMessage[]; files?: StudioFile[] } {
  const history = toStudioHistory(messages);
  return files.length > 0 ? { messages: history, files } : { messages: history };
}

/**
 * The transport `useChat` drives. `getFiles` reads the session's current file
 * set at send time — the files live in the studio session store, not in the
 * chat, and the transport must never capture a stale copy.
 */
export function studioChatTransport(getFiles: () => StudioFile[]) {
  return new DefaultChatTransport<UIMessage>({
    prepareSendMessagesRequest: ({ messages }) => {
      const { url, headers } = streamingEndpoint("/ai-studio/chat");
      return { api: url, headers, body: prepareStudioBody(messages, getFiles()) };
    },
  });
}
