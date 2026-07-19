/**
 * GP-143: the zip round-trips — unzipping yields the exact file set shown,
 * plus the generated README.
 */
import { expect, it } from "vitest";
import JSZip from "jszip";

import { buildStudioZip, studioReadme } from "./studio-zip";

const FILES = [
  { path: "main.tf", content: 'resource "azurerm_resource_group" "rg" {}\n' },
  { path: "modules/net/vnet.tf", content: 'resource "azurerm_virtual_network" "v" {}\n' },
];

it("zips the exact file set plus a README", async () => {
  const blob = await buildStudioZip(FILES);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());

  const paths = Object.keys(zip.files).filter((p) => !zip.files[p]!.dir);
  expect(paths.toSorted()).toEqual([
    "README.md",
    "main.tf",
    "modules/net/vnet.tf",
  ]);
  expect(await zip.file("main.tf")!.async("string")).toBe(FILES[0]!.content);
  expect(await zip.file("modules/net/vnet.tf")!.async("string")).toBe(
    FILES[1]!.content,
  );
  expect(await zip.file("README.md")!.async("string")).toBe(
    studioReadme(FILES),
  );
});

it("the README lists the files and the plan/apply steps", () => {
  const readme = studioReadme(FILES);
  expect(readme).toContain("`main.tf`");
  expect(readme).toContain("`modules/net/vnet.tf`");
  expect(readme).toContain("terraform init");
  expect(readme).toContain("terraform plan");
  expect(readme).toContain("Review it before applying");
});
