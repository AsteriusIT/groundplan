# Groundplan — Terraform Architecture Preview (VS Code)

Live, interactive architecture diagram of the Terraform in your workspace,
rendered beside your editor. **Runs entirely locally: your code never leaves
your machine, no account, no network.**

## Develop

```sh
pnpm --filter groundplan-vscode build   # host (esbuild) + webview (Vite)
pnpm --filter groundplan-vscode test    # node:test over the pure helpers
```

Then launch an Extension Development Host on this folder:

```sh
code --extensionDevelopmentPath=$PWD/apps/vscode <a-terraform-repo>
```

and run **Groundplan: Open Preview** from the command palette.
