/**
 * The message protocol between the extension host and the webview (GP-147+).
 * One file, imported by both bundles, so the two sides cannot drift.
 */
import type { Graph } from "@groundplan/graph-parser";

/** Host → webview. */
export type HostMessage =
  | {
      type: "snapshot";
      snapshot: Graph;
      /** The workspace folder previewed, and whether others were ignored. */
      folder: string;
      multiRoot: boolean;
    }
  | {
      /** GP-148: the last parse failed — the graph shown is the last good one. */
      type: "outOfSync";
      value: boolean;
    }
  | {
      /** GP-149: cursor → node. Select (or clear) from the editor side. */
      type: "select";
      address: string | null;
    };

/** Webview → host. */
export type WebviewMessage =
  | { type: "ready" }
  | {
      /** GP-149: node → code. The user clicked a node (null = cleared). */
      type: "nodeSelected";
      address: string | null;
    };
