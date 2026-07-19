# Publishing the VS Code extension (GP-150)

The extension lives in `apps/vscode` (`groundplan-vscode`), fully bundled — the
`.vsix` carries `dist/`, `media/`, README and LICENSE only (see
`.vscodeignore`), so packaging needs no `node_modules` and uses
`vsce package --no-dependencies`.

## One-time setup (human steps)

1. **Trademark/domain check** for the public name "Groundplan" (project
   knowledge Part 6 #3) — do this before the listing goes live.
2. **Marketplace publisher**: create the `asteriusit` publisher at
   <https://marketplace.visualstudio.com/manage> (sign in with a Microsoft
   account tied to an Azure DevOps org). Create a PAT with the
   **Marketplace → Manage** scope and save it as the repo secret **`VSCE_PAT`**.
3. **Open VSX** (covers VSCodium / Cursor): create an account at
   <https://open-vsx.org>, sign the publisher agreement, create an access
   token and save it as the repo secret **`OVSX_PAT`**. Create the
   `asteriusit` namespace once: `npx ovsx create-namespace asteriusit`.
4. **Listing GIF**: record 15–30s of typing HCL with the preview open (graph
   grows as you type), save as `apps/vscode/media/preview.gif`, and uncomment
   the image in `apps/vscode/README.md`. Keep it under ~5 MB.

## Releasing

1. Bump `version` in `apps/vscode/package.json` (the manifest is the single
   source of the version).
2. Tag and push: `git tag vscode-v<version> && git push origin vscode-v<version>`.
3. The `vscode-extension` workflow builds, tests, packages, then:
   - **creates a GitHub release** for the tag with the `.vsix` attached and
     generated notes (always — no store account needed; users can install it
     with `code --install-extension groundplan.vsix`);
   - publishes to the **Marketplace** and **Open VSX** when `VSCE_PAT` /
     `OVSX_PAT` exist — each store is skipped with a run notice until its
     secret is configured, so early releases don't fail.

   A tag whose version does not match the manifest fails the run before
   anything publishes. Re-running a tag's workflow re-attaches the `.vsix` to
   the existing release rather than failing.

`workflow_dispatch` runs the same job without releasing or publishing
(artifact only) — use it to smoke-test the package.

## Smoke test (per release)

- Install the artifact in a **clean** VS Code profile:
  `code --profile groundplan-smoke --install-extension groundplan.vsix`.
- Open a Terraform repo, run *Groundplan: Open Preview* — full graph, correct
  blueprint styling, vendor icons, edges.
- Disconnect the network and repeat: identical behaviour (offline principle).
- Type a new `resource` block: node appears ≈1s after pausing, before saving.
- Break a block: diagram keeps last good state, out-of-sync chip shows, the
  Problems panel names the file; fixing clears both.
- Click a node → editor opens the block; cursor in a block → node highlights.
- Check the `.vsix` stays under 5 MB (the CI job asserts this too).
- Ideally repeat on Windows + one Unix (the CI packaging job runs on Linux).
