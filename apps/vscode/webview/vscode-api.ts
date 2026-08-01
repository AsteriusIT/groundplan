/**
 * The one place that knows the webview runs inside VS Code.
 *
 * `acquireVsCodeApi` may be called exactly once per webview, so the handle is
 * acquired lazily and kept. Outside a webview — a test — there is no host to
 * talk to and posting is a no-op; a panel that threw on mount because nobody
 * was listening would be untestable for no gain.
 */
import type { WebviewMessage } from "../src/messages";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
};

let host: { postMessage(message: WebviewMessage): void } | null = null;

export function postToHost(message: WebviewMessage): void {
  if (host === null) {
    host =
      typeof acquireVsCodeApi === "function"
        ? acquireVsCodeApi()
        : { postMessage: () => {} };
  }
  host.postMessage(message);
}
