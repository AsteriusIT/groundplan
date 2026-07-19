# Groundplan — Terraform Architecture Preview

**See your Terraform as a live architecture diagram, beside your editor, while
you type.** New `resource` blocks appear in the diagram about a second after
you pause — before you save. Click a node to jump to its HCL; move your cursor
into a block and the diagram highlights it.

<!-- TODO(listing): record a 15–30s GIF of typing HCL → the graph growing and
     save it as media/preview.gif, then uncomment:
![Groundplan live preview](media/preview.gif)
-->

## Runs locally. Your code never leaves your machine.

Groundplan parses your `.tf` files **inside the extension host** — no cloud
calls, no account, no telemetry, and it works fully offline. Nothing is ever
uploaded anywhere. That is the whole trust model, and it is non-negotiable.

## What you get

- **Live preview** — the preview button in any `.tf` editor's title bar (or
  `Groundplan: Open Preview` from the palette) renders the current workspace
  folder's Terraform as an interactive diagram (pan, zoom, search, filters),
  with real vendor icons for Azure, AWS, GCP and Kubernetes resources.
- **Live while you type** — unsaved edits count. A syntax error never blanks
  the panel: the last good diagram stays, marked *out of sync*, and the error
  lands in the Problems panel with its file until you fix it.
- **Node ↔ code navigation** — click a node to open its block in the editor;
  put your cursor in a `resource` block to light up its node in the diagram.
- **Same graph as the Groundplan platform** — module containment, explicit
  *and* expression-inferred dependencies, network containment, NSG/IAM
  payloads.

## Notes & limits

- Multi-root workspaces preview the first folder (the panel says so).
- `helm`/`kustomize`/plan.json rendering is not part of the extension; the
  [Groundplan web product](https://github.com/AsteriusIT/groundplan) covers
  PR review, visual diffs and living documentation for your whole estate.
- Very large repositories (500+ resources) are not tuned for yet.

## Develop (this repo)

```sh
pnpm --filter groundplan-vscode build     # host (esbuild) + webview (Vite)
pnpm --filter groundplan-vscode test      # node:test over the pure helpers
pnpm --filter groundplan-vscode package   # → groundplan.vsix
code --extensionDevelopmentPath=$PWD/apps/vscode <a-terraform-repo>
```

Release flow: see [docs/vscode-publishing.md](../../docs/vscode-publishing.md).
