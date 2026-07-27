/**
 * Repository kind detection (GP-228) on fixture trees.
 *
 * The kind is immutable once imported, so the interesting assertions here are
 * the ones about *refusing to guess*: a monorepo, a truncated tree and an
 * unrecognisable repository must never come back `high`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectRepoKind, type FileEntry } from "./repo-kind.js";

const file = (path: string, head?: string): FileEntry =>
  head === undefined ? { path, type: "file" } : { path, type: "file", head };
const dir = (path: string): FileEntry => ({ path, type: "dir" });

const DEPLOYMENT = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n";

test("a Terraform repository is detected with high confidence", () => {
  const result = detectRepoKind([
    file("main.tf"),
    file("variables.tf"),
    file(".terraform.lock.hcl"),
    file("README.md"),
  ]);
  assert.equal(result.kind, "terraform");
  assert.equal(result.confidence, "high");
  assert.ok(result.evidence.includes("main.tf"));
});

test("terragrunt and .tf.json count as Terraform", () => {
  assert.equal(detectRepoKind([file("terragrunt.hcl")]).kind, "terraform");
  assert.equal(detectRepoKind([file("stack.tf.json")]).kind, "terraform");
});

test("raw manifests are Kubernetes — from the head keys, not the extension", () => {
  const result = detectRepoKind([
    file("deployment.yaml", DEPLOYMENT),
    file("service.yaml", "apiVersion: v1\nkind: Service\n"),
  ]);
  assert.equal(result.kind, "kubernetes");
  assert.equal(result.confidence, "high");
});

test("a Helm chart is Kubernetes without reading a single file", () => {
  const result = detectRepoKind([
    file("Chart.yaml"),
    file("values.yaml"),
    file("templates/deployment.yaml"),
  ]);
  assert.equal(result.kind, "kubernetes");
  assert.equal(result.confidence, "high");
  assert.ok(result.evidence.some((e) => e.toLowerCase().includes("chart.yaml")));
});

test("a kustomize layout is Kubernetes on its shape alone", () => {
  const result = detectRepoKind([
    dir("base"),
    dir("overlays"),
    file("base/deployment.yaml"),
    file("overlays/prod/patch.yaml"),
  ]);
  assert.equal(result.kind, "kubernetes");
  assert.equal(result.confidence, "high");
});

test("a YAML file that is not a manifest proves nothing", () => {
  // The exact trap: every repository on earth has CI YAML.
  const result = detectRepoKind([
    file(".github/workflows/ci.yaml", "name: CI\non:\n  push:\n"),
    file("docker-compose.yml", "services:\n  api:\n    image: api\n"),
    file("README.md"),
  ]);
  assert.equal(result.kind, null);
  assert.equal(result.confidence, "low");
  assert.deepEqual(result.evidence, []);
});

test("a monorepo refuses to choose, and shows both sides", () => {
  const result = detectRepoKind([
    file("infra/main.tf"),
    file("k8s/deployment.yaml", DEPLOYMENT),
  ]);
  assert.equal(result.kind, null, "there is no mixed kind — it is two imports");
  assert.equal(result.confidence, "low");
  assert.ok(result.evidence.includes("infra/main.tf"));
  assert.ok(result.evidence.includes("k8s/deployment.yaml"));
  assert.equal(result.suggestedPath, null);
});

test("a truncated tree never yields high confidence", () => {
  const whole = detectRepoKind([file("main.tf")]);
  const cut = detectRepoKind([file("main.tf")], { truncated: true });
  assert.equal(whole.confidence, "high");
  assert.equal(cut.kind, "terraform", "what we saw is still evidence");
  assert.equal(cut.confidence, "low", "…but it is no longer the whole story");
});

test("an empty repository is a refusal, not a guess", () => {
  const result = detectRepoKind([]);
  assert.deepEqual(result, {
    kind: null,
    confidence: "low",
    evidence: [],
    suggestedPath: null,
  });
});

test("a path is suggested when everything relevant sits in one directory", () => {
  assert.equal(
    detectRepoKind([file("infra/main.tf"), file("infra/vars.tf"), file("README.md")])
      .suggestedPath,
    "infra",
  );
  assert.equal(
    detectRepoKind([file("manifests/api.yaml", DEPLOYMENT)]).suggestedPath,
    "manifests",
  );
});

test("no path is suggested when the files are spread or already at the root", () => {
  assert.equal(
    detectRepoKind([file("main.tf"), file("modules/net/main.tf")]).suggestedPath,
    null,
  );
  assert.equal(
    detectRepoKind([file("infra/main.tf"), file("terraform/main.tf")]).suggestedPath,
    null,
  );
});

test("detection can be scoped to a path, and only sees inside it", () => {
  const tree = [
    file("infra/main.tf"),
    file("k8s/deployment.yaml", DEPLOYMENT),
  ];
  assert.equal(detectRepoKind(tree, { path: "infra" }).kind, "terraform");
  assert.equal(detectRepoKind(tree, { path: "k8s" }).kind, "kubernetes");
  assert.equal(detectRepoKind(tree, { path: "docs" }).kind, null);
});

test("directory entries alone never decide a kind", () => {
  const result = detectRepoKind([dir("terraform"), dir("kubernetes")]);
  assert.equal(result.kind, null);
});

test("evidence is capped: the UI shows examples, not a file tree", () => {
  const many = Array.from({ length: 40 }, (_, i) => file(`module-${i}.tf`));
  const result = detectRepoKind(many);
  assert.equal(result.kind, "terraform");
  assert.ok(result.evidence.length <= 5, "at most a handful of examples");
});
