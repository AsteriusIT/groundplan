import { expect, it } from "vitest";

import {
  baseName,
  buildFileTree,
  folderOf,
  isUnder,
  renamedUnder,
  type TreeFolder,
} from "./file-tree";

it("reads a folder out of a path, and a name out of it", () => {
  expect(folderOf("modules/network/main.tf")).toBe("modules/network");
  expect(folderOf("main.tf")).toBe("");
  expect(baseName("modules/network/main.tf")).toBe("main.tf");
  expect(baseName("main.tf")).toBe("main.tf");
});

it("nests a module layout by the prefixes its paths share", () => {
  const tree = buildFileTree([
    "main.tf",
    "modules/network/main.tf",
    "modules/network/outputs.tf",
    "modules/data/main.tf",
  ]);

  // Folders first, then files; each alphabetical.
  expect(tree.map((e) => e.path)).toEqual(["modules", "main.tf"]);
  const modules = tree[0] as TreeFolder;
  expect(modules.children.map((e) => e.path)).toEqual([
    "modules/data",
    "modules/network",
  ]);
  const network = modules.children[1] as TreeFolder;
  expect(network.children.map((e) => e.name)).toEqual([
    "main.tf",
    "outputs.tf",
  ]);
});

it("shows a folder somebody made before they put anything in it", () => {
  const tree = buildFileTree(["main.tf"], ["modules/network"]);
  expect(tree.map((e) => e.path)).toEqual(["modules", "main.tf"]);
  const modules = tree[0] as TreeFolder;
  expect((modules.children[0] as TreeFolder).children).toEqual([]);
});

it("does not draw a folder twice when it is both declared and used", () => {
  const tree = buildFileTree(["modules/network/main.tf"], ["modules/network"]);
  const modules = tree[0] as TreeFolder;
  expect(modules.children).toHaveLength(1);
  expect((modules.children[0] as TreeFolder).children.map((e) => e.name)).toEqual(
    ["main.tf"],
  );
});

it("renaming a folder is renaming every path under it", () => {
  const paths = ["main.tf", "modules/network/main.tf", "modules/data/main.tf"];
  expect(renamedUnder(paths, "modules/network", "modules/vpc")).toEqual([
    { from: "modules/network/main.tf", to: "modules/vpc/main.tf" },
  ]);
  expect(isUnder("modules/network/main.tf", "modules")).toBe(true);
  expect(isUnder("modulesx/main.tf", "modules")).toBe(false);
});
