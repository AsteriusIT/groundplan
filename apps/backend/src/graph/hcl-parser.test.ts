import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateGraph } from "./graph.js";
import { parseHclRepo, type HclFile } from "./hcl-parser.js";

/** Read a committed fixture repo directory into a flat list of files. */
function readRepo(rel: string): HclFile[] {
  const root = fileURLToPath(new URL(`./__fixtures__/${rel}`, import.meta.url));
  const out: HclFile[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = `${dir}/${name}`;
      const path = prefix ? `${prefix}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, path);
      else out.push({ path, content: readFileSync(abs, "utf8") });
    }
  };
  walk(root, "");
  return out;
}

function readJson(rel: string): unknown {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__fixtures__/${rel}`, import.meta.url)), "utf8"),
  );
}

test("parses the fixture repo (root + local module) into the expected graph", () => {
  const { graph } = parseHclRepo(readRepo("hcl-repo"));
  assert.equal(validateGraph(graph).valid, true);
  assert.deepEqual(graph, readJson("graphs/hcl-repo.graph.json"));
});

test("infers a connected graph from expressions (docs flow, GP-21)", () => {
  const { graph } = parseHclRepo(readRepo("hcl-expressions"));
  assert.equal(validateGraph(graph).valid, true);
  assert.deepEqual(graph, readJson("graphs/hcl-expressions.graph.json"));
});

test("the vm -> nic -> subnet -> vnet chain is visible via expressions", () => {
  const { graph } = parseHclRepo(readRepo("hcl-expressions"));
  const dep = (from: string, to: string) =>
    graph.edges.some((e) => e.from === from && e.to === to && e.kind === "depends_on");
  assert.ok(dep("azurerm_virtual_machine.main", "azurerm_network_interface.main"));
  assert.ok(dep("azurerm_network_interface.main", "azurerm_subnet.internal"));
  assert.ok(dep("azurerm_subnet.internal", "azurerm_virtual_network.main"));
  // A data-source reference and a module-input reference are edges too.
  assert.ok(dep("azurerm_virtual_machine.main", "data.azurerm_image.ubuntu"));
  assert.ok(dep("module.monitoring", "azurerm_virtual_network.main"));
  // All expression-derived, so every depends_on edge is inferred.
  assert.ok(graph.edges.filter((e) => e.kind === "depends_on").every((e) => e.inferred === true));
});

test("derives vnet⊃subnet⊃NIC containment (parent_id) and escalates to v4 (GP-42)", () => {
  const { graph } = parseHclRepo(readRepo("hcl-expressions"));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // v8 since every parsed block now carries its HCL source (GP-120) — the ladder
  // still runs through v4 containment and v7 attributes, it just tops out higher.
  assert.equal(graph.version, 8);
  assert.equal(
    byId.get("azurerm_subnet.internal")?.parent_id,
    "azurerm_virtual_network.main",
  );
  assert.equal(
    byId.get("azurerm_network_interface.main")?.parent_id,
    "azurerm_subnet.internal",
  );
  // The VM references only a NIC → no subnet containment parent.
  // The via rule (network-schema-polish): the VM lands in its NIC's subnet.
  assert.equal(
    byId.get("azurerm_virtual_machine.main")?.parent_id,
    "azurerm_subnet.internal",
  );
});

test("derives satellite stacking from HCL: probe/pool/rule → lb, public IP → host, NIC → VM (GP-86)", () => {
  const { graph } = parseHclRepo(readRepo("hcl-stacking"));
  assert.equal(validateGraph(graph).valid, true);
  const parent = new Map(graph.nodes.map((n) => [n.id, n.parent_id]));
  assert.equal(parent.get("azurerm_lb.main"), "azurerm_subnet.internal");
  assert.equal(parent.get("azurerm_lb_probe.https"), "azurerm_lb.main");
  assert.equal(parent.get("azurerm_lb_backend_address_pool.pool"), "azurerm_lb.main");
  assert.equal(parent.get("azurerm_lb_rule.http"), "azurerm_lb.main");
  assert.equal(parent.get("azurerm_public_ip.appgw"), "azurerm_application_gateway.appgw");
  assert.equal(parent.get("azurerm_public_ip.bastion"), "azurerm_bastion_host.bastion");
  assert.equal(parent.get("azurerm_network_interface.nic"), "azurerm_linux_virtual_machine.vm");
  // A NAT gateway binds its public IP via an association resource → resolved through it.
  assert.equal(parent.get("azurerm_public_ip.nat"), "azurerm_nat_gateway.nat");
});

test("attaches NSG rules, internet_exposed, and associations from HCL (GP-43)", () => {
  const { graph } = parseHclRepo(readRepo("hcl-nsg"));
  // v8 since every parsed block carries its HCL source (GP-120).
  assert.equal(graph.version, 8);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const open = byId.get("azurerm_network_security_group.open")!;
  assert.equal(open.rules?.length, 2);
  assert.deepEqual(open.rules?.[0], {
    name: "allow-https",
    priority: 100,
    direction: "Inbound",
    access: "Allow",
    protocol: "Tcp",
    ports: "443",
    source: "Internet",
    destination: "*",
  });
  assert.equal(open.internet_exposed, true);
  assert.deepEqual(open.associated_ids, ["azurerm_subnet.web"]);
});

test("attaches route-table associated_ids to the route table, without NSG payload (GP-89)", () => {
  const { graph } = parseHclRepo(readRepo("hcl-nsg"));
  const rt = new Map(graph.nodes.map((n) => [n.id, n])).get("azurerm_route_table.rt")!;
  assert.deepEqual(rt.associated_ids, ["azurerm_subnet.web"]);
  assert.equal(rt.rules, undefined);
  assert.equal(rt.internet_exposed, undefined);
});

test("attaches role-assignment triples, privileged flags, and identities from HCL (GP-47)", () => {
  const { graph } = parseHclRepo(readRepo("hcl-iam"));
  // v8 since every parsed block carries its HCL source (GP-120).
  assert.equal(graph.version, 8);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  // AcrPull: principal resolves to the identity, scope to the registry; narrow.
  const acrPull = byId.get("azurerm_role_assignment.acr_pull")!;
  assert.deepEqual(acrPull.role_assignment, {
    role: "AcrPull",
    principal: "azurerm_user_assigned_identity.aks",
    scope: "azurerm_container_registry.main",
  });
  assert.equal(acrPull.privileged, false);

  // Owner at RG: literal principal id kept, scope resolves to the RG → privileged.
  const owner = byId.get("azurerm_role_assignment.owner_rg")!;
  assert.deepEqual(owner.role_assignment, {
    role: "Owner",
    principal: "11111111-1111-1111-1111-111111111111",
    scope: "azurerm_resource_group.main",
    principal_type: "ServicePrincipal",
  });
  assert.equal(owner.privileged, true);

  // Reader at RG: broad scope but weak role → not privileged.
  assert.equal(byId.get("azurerm_role_assignment.reader_rg")!.privileged, false);

  // Managed identities: the UAI itself, and the AKS cluster that uses it.
  assert.deepEqual(byId.get("azurerm_user_assigned_identity.aks")!.identity, {
    type: "UserAssigned",
  });
  assert.deepEqual(byId.get("azurerm_kubernetes_cluster.main")!.identity, {
    type: "UserAssigned",
    identity_ids: ["azurerm_user_assigned_identity.aks"],
  });
});

test("unresolved references are captured (readable list), not just counted", () => {
  const { graph, warnings, unresolvedReferences } = parseHclRepo(
    readRepo("hcl-expressions"),
  );
  // azurerm_virtual_network.secondary is referenced but not declared.
  assert.ok(!graph.nodes.some((n) => n.id.includes("secondary")));

  // It is no longer an opaque count in warnings — it is a structured entry a
  // reader can open, carrying the target it could not find.
  assert.ok(
    !warnings.some((w) => /could not be resolved/.test(w)),
    `unresolved refs should not be a warning string, got ${JSON.stringify(warnings)}`,
  );
  const secondary = unresolvedReferences.find((u) =>
    u.ref.includes("azurerm_virtual_network.secondary"),
  );
  assert.ok(
    secondary,
    `expected a captured unresolved reference, got ${JSON.stringify(unresolvedReferences)}`,
  );
  assert.ok(secondary.from.length > 0, "an unresolved reference names its source");
  assert.ok(secondary.reason, "an unresolved reference explains itself");
});

test("a registry module source becomes a single leaf node (no recursion)", () => {
  const { graph } = parseHclRepo(readRepo("hcl-repo"));
  const registry = graph.nodes.filter((n) => n.id.startsWith("module.vpc_registry"));
  assert.equal(registry.length, 1, "registry module → exactly one node");
  assert.equal(registry[0]?.type, "module");
});

test("an unparseable .tf file is skipped with a warning; the rest still parse", () => {
  const { graph, warnings } = parseHclRepo(readRepo("hcl-repo"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] as string, /broken\.tf/);
  // The broken resource is absent, but valid resources are present.
  assert.ok(!graph.nodes.some((n) => n.id.includes("aws_thing")));
  assert.ok(graph.nodes.some((n) => n.id === "aws_s3_bucket.logs"));
});

test("only explicit depends_on becomes an edge (no expression evaluation)", () => {
  const { graph } = parseHclRepo(readRepo("hcl-repo"));
  const depEdges = graph.edges.filter((e) => e.kind === "depends_on");
  // Exactly the two explicit depends_on relationships — the aws_vpc.this.id
  // expression reference must NOT add an edge.
  assert.equal(depEdges.length, 2);
});

test("output ordering is deterministic (byte-stable)", () => {
  const files = readRepo("hcl-repo");
  assert.equal(
    JSON.stringify(parseHclRepo(files).graph),
    JSON.stringify(parseHclRepo(files).graph),
  );
});

test("a 200-file repo parses in well under 30 seconds", () => {
  const files: HclFile[] = Array.from({ length: 200 }, (_, i) => ({
    path: `r${i}.tf`,
    content: `resource "aws_s3_bucket" "b${i}" {\n  bucket = "b${i}"\n}\n`,
  }));
  const start = process.hrtime.bigint();
  const { graph } = parseHclRepo(files);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(graph.nodes.length, 200);
  assert.ok(ms < 30000, `expected < 30000ms, took ${ms.toFixed(1)}ms`);
});

// --- Terraform root directory (repositories whose HCL is not at the root) ----

/** A repo whose stack lives in `infra/`, with a module *above* it in `modules/`. */
function subdirRepo(): HclFile[] {
  return [
    {
      path: "infra/main.tf",
      content: `resource "aws_s3_bucket" "app" {\n  bucket = "app"\n}\n\nmodule "shared" {\n  source = "../modules/shared"\n}\n`,
    },
    {
      path: "modules/shared/main.tf",
      content: `resource "aws_kms_key" "k" {\n  description = "shared"\n}\n`,
    },
    // A second, unrelated stack that must not leak into the graph.
    {
      path: "other/main.tf",
      content: `resource "aws_s3_bucket" "other" {\n  bucket = "other"\n}\n`,
    },
  ];
}

test("a root directory makes that subtree the entrypoint", () => {
  const { graph } = parseHclRepo(subdirRepo(), { rootDir: "infra" });
  const ids = graph.nodes.map((n) => n.id).sort();

  assert.ok(ids.includes("aws_s3_bucket.app"), "the stack under the root is parsed");
  assert.ok(
    !ids.includes("aws_s3_bucket.other"),
    "a stack outside the root is not reachable from the entrypoint",
  );
  // Addresses are Terraform addresses, not file paths: the root directory does
  // not appear in them, so a plan snapshot and a docs snapshot still line up.
  assert.ok(!ids.some((id) => id.includes("infra")));
});

test("a local module above the root directory still resolves", () => {
  const { graph } = parseHclRepo(subdirRepo(), { rootDir: "infra" });
  const ids = graph.nodes.map((n) => n.id);

  assert.ok(ids.includes("module.shared"));
  assert.ok(
    ids.includes("module.shared.aws_kms_key.k"),
    "a ../ module source resolves outside the root, as terraform -chdir does",
  );
});

test("without a root directory the whole-repo behaviour is unchanged", () => {
  const { graph } = parseHclRepo(subdirRepo());
  // Nothing is at the repository root, so nothing is reachable.
  assert.equal(graph.nodes.length, 0);
});

test("a root directory holding no .tf files warns instead of silently emptying", () => {
  const { graph, warnings } = parseHclRepo(subdirRepo(), { rootDir: "nope" });
  assert.equal(graph.nodes.length, 0);
  assert.ok(
    warnings.some((w) => w.includes("nope")),
    `expected a warning naming the directory, got ${JSON.stringify(warnings)}`,
  );
});

test("the join catalog places, attaches, and edges association resources (azurerm joins)", () => {
  const { graph } = parseHclRepo(readRepo("hcl-joins"));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const hasEdge = (from: string, to: string) =>
    graph.edges.some((e) => e.kind === "depends_on" && e.from === from && e.to === to);

  // subnet_nat_gateway_association → the NAT gateway nests in its subnet.
  assert.equal(byId.get("azurerm_nat_gateway.out")?.parent_id, "azurerm_subnet.internal");
  // Two subnets share one NAT gateway → nearest common ancestor: the vnet —
  // with a dashed edge to each served subnet.
  assert.equal(
    byId.get("azurerm_nat_gateway.shared")?.parent_id,
    "azurerm_virtual_network.hub",
  );
  assert.ok(
    hasEdge("azurerm_nat_gateway.shared", "azurerm_subnet.internal") &&
      hasEdge("azurerm_nat_gateway.shared", "azurerm_subnet.internal2"),
    "expected direct edges from the shared NAT gateway to both served subnets",
  );
  // data-disk attachment → the disk stacks under its VM.
  assert.equal(
    byId.get("azurerm_managed_disk.data")?.parent_id,
    "azurerm_linux_virtual_machine.app",
  );
  // vnet peering collapses to one direct vnet ⇄ vnet edge.
  assert.ok(
    hasEdge("azurerm_virtual_network.hub", "azurerm_virtual_network.spoke") ||
      hasEdge("azurerm_virtual_network.spoke", "azurerm_virtual_network.hub"),
    "expected a direct edge between the peered vnets",
  );
  // NIC ↔ LB pool association collapses to a direct NIC → pool edge.
  assert.ok(
    hasEdge("azurerm_network_interface.nic", "azurerm_lb_backend_address_pool.pool"),
    "expected a direct NIC → pool edge",
  );
  // VMSS inline NSG duality: the NSG records the scale set it guards.
  assert.deepEqual(byId.get("azurerm_network_security_group.web")?.associated_ids, [
    "azurerm_linux_virtual_machine_scale_set.workers",
  ]);
  // Inline avset duality: availability_set_id → the avset chips onto its VM.
  assert.deepEqual(byId.get("azurerm_availability_set.app")?.associated_ids, [
    "azurerm_linux_virtual_machine.app",
  ]);
  // And the via rule places the VM in its NIC's subnet.
  assert.equal(
    byId.get("azurerm_linux_virtual_machine.app")?.parent_id,
    "azurerm_subnet.internal",
  );
});

test("subnet and vnet CIDRs land in attributes", () => {
  const { graph } = parseHclRepo([
    {
      path: "main.tf",
      content: `
resource "azurerm_virtual_network" "hub" {
  name          = "hub"
  address_space = ["10.0.0.0/16"]
}
resource "azurerm_subnet" "app" {
  name                 = "app"
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = ["10.0.1.0/24"]
}
resource "azurerm_subnet" "multi" {
  name                 = "multi"
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = ["10.0.2.0/24", "10.0.3.0/24"]
}
resource "azurerm_subnet" "dynamic" {
  name                 = "dynamic"
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = var.prefixes
}
`,
    },
  ]);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(
    byId.get("azurerm_subnet.app")?.attributes?.["address_prefixes"],
    "10.0.1.0/24",
  );
  assert.equal(
    byId.get("azurerm_subnet.multi")?.attributes?.["address_prefixes"],
    "10.0.2.0/24, 10.0.3.0/24",
  );
  // An expression CIDR is unknowable statically — no attribute at all.
  assert.equal(byId.get("azurerm_subnet.dynamic")?.attributes, undefined);
  assert.equal(
    byId.get("azurerm_virtual_network.hub")?.attributes?.["address_space"],
    "10.0.0.0/16",
  );
});

test("a literal count lands in attributes; an expression count does not", () => {
  const { graph } = parseHclRepo([
    {
      path: "main.tf",
      content: `
resource "azurerm_linux_virtual_machine" "app" {
  name  = "app"
  count = 2
}
resource "azurerm_linux_virtual_machine" "dyn" {
  name  = "dyn"
  count = var.n
}
`,
    },
  ]);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  assert.equal(
    byId.get("azurerm_linux_virtual_machine.app")?.attributes?.["count"],
    "2",
  );
  assert.equal(
    byId.get("azurerm_linux_virtual_machine.dyn")?.attributes?.["count"],
    undefined,
  );
});

// --- HCL source snippets (GP-120) -------------------------------------------

/** The lines `source` claims, taken straight out of the file it names. */
function linesOf(files: HclFile[], file: string, from: number, to: number): string {
  const content = files.find((f) => f.path === file)?.content;
  assert.ok(content !== undefined, `fixture has no file ${file}`);
  return content.split("\n").slice(from - 1, to).join("\n");
}

test("every parsed node carries the source that defines it, verbatim (GP-120)", () => {
  const files = readRepo("hcl-repo");
  const { graph } = parseHclRepo(files);

  for (const node of graph.nodes) {
    const src = node.source;
    assert.ok(src, `${node.id} has no source`);
    assert.ok(src.code.length > 0, `${node.id} has empty source code`);
    assert.ok(src.start_line >= 1 && src.end_line >= src.start_line, `${node.id} span`);
    // Byte-for-byte: the snippet IS the file's text over the span it claims.
    assert.equal(
      src.code,
      linesOf(files, src.file, src.start_line, src.end_line),
      `${node.id} source does not match ${src.file}:${src.start_line}-${src.end_line}`,
    );
  }
});

test("a source snippet spans the whole block, comments included (GP-120)", () => {
  const { graph } = parseHclRepo(readRepo("hcl-repo"));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const role = byId.get("aws_iam_role.app")?.source;
  assert.equal(role?.file, "main.tf");
  // Opens on the `resource` keyword, closes on the block's own brace.
  assert.ok(role?.code.startsWith('resource "aws_iam_role" "app" {'));
  assert.ok(role?.code.endsWith("}"));
  // A comment inside the block is part of the block — the reader wrote it there.
  assert.ok(role?.code.includes("# Nested block"));
  assert.ok(role?.code.includes("inline_policy {"));

  // A heredoc holding braces must not end the block early (scanner regression).
  const bucket = byId.get("aws_s3_bucket.logs")?.source;
  assert.ok(bucket?.code.includes("POLICY"));
  assert.ok(bucket?.code.trimEnd().endsWith("}"));
});

test("a module node's source is its call block, not the module's files (GP-120)", () => {
  const { graph } = parseHclRepo(readRepo("hcl-repo"));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const call = byId.get("module.network")?.source;
  assert.equal(call?.file, "main.tf");
  assert.ok(call?.code.startsWith('module "network" {'));
  assert.ok(call?.code.includes('source = "./modules/network"'));

  // A resource *inside* the module points at the module's own file.
  assert.equal(byId.get("module.network.aws_vpc.this")?.source?.file, "modules/network/network.tf");
});

test("line numbers are 1-based and count from the top of the file (GP-120)", () => {
  const [file] = [
    {
      path: "main.tf",
      content: '# a comment\n\nresource "aws_s3_bucket" "b" {\n  bucket = "b"\n}\n',
    },
  ];
  const { graph } = parseHclRepo([file!]);
  const src = graph.nodes[0]?.source;
  assert.equal(src?.start_line, 3);
  assert.equal(src?.end_line, 5);
  assert.equal(src?.code, 'resource "aws_s3_bucket" "b" {\n  bucket = "b"\n}');
});

test("carrying source escalates the graph to v8 (GP-120)", () => {
  const { graph } = parseHclRepo(readRepo("hcl-repo"));
  assert.equal(graph.version, 8);
  assert.equal(validateGraph(graph).valid, true);
});
