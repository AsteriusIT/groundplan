/**
 * @groundplan/canvas — the Groundplan diagram canvas as a reusable package
 * (GP-146): React Flow + ELK layout + design-v3 nodes/edges + blueprint theme
 * + vendor icons + search/neighborhood highlight. Consumed by the web app and
 * the VS Code webview. Import `@groundplan/canvas/styles.css` for the tokens.
 */
export * from "./types";

export * from "./components/graph-canvas";
export * from "./components/graph-node";
export * from "./components/graph-edge";
export * from "./components/network-container-node";
export * from "./components/group-container-node";
export * from "./components/attachment-chip";
export * from "./components/node-details-panel";
export * from "./components/iam-table";
export * from "./components/note-editor";
export * from "./components/change-summary";
export * from "./components/tour-spotlight";
export * from "./components/tour-chrome";
export * from "./components/resource-icon";
export * from "./components/copy-button";
export * from "./components/ai-response";

export * from "./components/ui/chip";
export * from "./components/ui/status-badge";
export * from "./components/ui/side-panel";
export * from "./components/ui/button";
export * from "./components/ui/dialog";
export * from "./components/ui/ai-badge";

export * from "./lib/graph-layout";
export * from "./lib/edge-path";
export * from "./lib/hub";
export * from "./lib/hub-config";
export * from "./lib/graph-search";
export * from "./lib/resource-category";
export * from "./lib/status";
export * from "./lib/node-details";
export * from "./lib/hcl-highlight";
export * from "./lib/annotations";
export * from "./lib/annotate-tool";
export * from "./lib/utils";

export * from "./panel/panel-prefs";

export * from "./icons/resource-icon";
export * from "./icons/azure-icons";
export * from "./icons/aws-icons";
export * from "./icons/gcp-icons";
export * from "./icons/kubernetes-icons";
export * from "./icons/azurerm";
export * from "./icons/aws";
export * from "./icons/gcp";
export * from "./icons/kubernetes";
