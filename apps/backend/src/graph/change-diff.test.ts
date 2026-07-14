import { test } from "node:test";
import assert from "node:assert/strict";

import { changesFromBase } from "./change-diff.js";
import { assertValidGraph, computeGraphStats } from "./graph.js";
import { mapK8sObjects, type K8sObject } from "./k8s-mapper.js";

const deployment = (name: string, image: string, replicas = 1): K8sObject => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name, namespace: "prod" },
  spec: {
    replicas,
    template: {
      metadata: { labels: { app: name } },
      spec: { containers: [{ name, image }] },
    },
  },
});

const service = (name: string): K8sObject => ({
  apiVersion: "v1",
  kind: "Service",
  metadata: { name, namespace: "prod" },
  spec: { selector: { app: name }, ports: [{ port: 80 }] },
});

const configMap = (name: string): K8sObject => ({
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name, namespace: "prod" },
  data: { LOG_LEVEL: "info" },
});

test("golden: the three colours a reviewer came for", () => {
  // main: an api at 1.4.0, and a config nobody will keep.
  const base = mapK8sObjects([deployment("api", "acme/api:1.4.0"), configMap("legacy")]);
  // the pull request: the image moves, a service appears, the config is gone.
  const head = mapK8sObjects([deployment("api", "acme/api:1.5.0"), service("api")]);

  const graph = changesFromBase(base, head);
  assertValidGraph(graph);

  const change = (id: string) => graph.nodes.find((n) => n.id === id)?.change;
  assert.equal(change("prod/Deployment/api"), "update");
  assert.equal(change("prod/Service/api"), "create");
  assert.equal(change("prod/ConfigMap/legacy"), "delete");
  // The namespace itself is untouched by any of it, and says so.
  assert.equal(change("Namespace/prod"), "noop");

  // The attribute diff is the reason the reviewer trusts the colour: not "this
  // changed" but "the image went from here to there".
  const api = graph.nodes.find((n) => n.id === "prod/Deployment/api");
  assert.deepEqual(
    api?.attribute_diff?.filter((row) => row.key.endsWith("image")),
    [
      {
        key: "spec.template.spec.containers[0].image",
        before: "acme/api:1.4.0",
        after: "acme/api:1.5.0",
      },
    ],
  );

  // What a pull request removes stays on the diagram — dropping it would hide
  // exactly the part worth reviewing — and it keeps the line that made sense of it.
  assert.ok(graph.edges.some((e) => e.to === "prod/ConfigMap/legacy" && e.kind === "contains"));

  const stats = computeGraphStats(graph);
  assert.equal(stats.changes.create, 1);
  assert.equal(stats.changes.update, 1);
  assert.equal(stats.changes.delete, 1);
  assert.equal(stats.changes.noop, 1, "the namespace");
});

test("no base at all: everything is new, which is true and is not 'nothing changed'", () => {
  const head = mapK8sObjects([deployment("api", "acme/api:1.0.0")]);
  const graph = changesFromBase(null, head);
  assertValidGraph(graph);

  assert.deepEqual(
    graph.nodes.map((n) => [n.id, n.change]),
    [
      ["Namespace/prod", "create"],
      ["prod/Deployment/api", "create"],
    ],
  );
  const api = graph.nodes.find((n) => n.id === "prod/Deployment/api");
  assert.equal(
    api?.attribute_diff?.find((r) => r.key.endsWith("image"))?.before,
    null,
    "a creation has no before",
  );
});

test("an identical head is all noop — a pull request that changes nothing says nothing", () => {
  const objects = [deployment("api", "acme/api:1.4.0"), service("api")];
  const graph = changesFromBase(mapK8sObjects(objects), mapK8sObjects(objects));
  assert.ok(graph.nodes.every((n) => n.change === "noop"));
  assert.equal(computeGraphStats(graph).changes.noop, graph.nodes.length);
});

test("a workload moving namespace is a delete and a create, not a 'move'", () => {
  const base = mapK8sObjects([deployment("api", "acme/api:1.0.0")]);
  const head = mapK8sObjects([
    { ...deployment("api", "acme/api:1.0.0"), metadata: { name: "api", namespace: "staging" } },
  ]);
  const graph = changesFromBase(base, head);

  // GP-40's differ would pair these as one node that *moved*, which is the right
  // answer to its question and the wrong one here: they are two objects, in two
  // namespaces, and "move" is not a colour the canvas can draw.
  assert.equal(graph.nodes.find((n) => n.id === "prod/Deployment/api")?.change, "delete");
  assert.equal(graph.nodes.find((n) => n.id === "staging/Deployment/api")?.change, "create");
});

test("a Secret's rotated value is invisible; a Secret's new key is not", () => {
  const secret = (data: Record<string, string>): K8sObject => ({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "db", namespace: "prod" },
    data,
  });

  // Both sides are masked to `(sensitive)`, so a rotation cannot be seen — the
  // price of never holding the value, and the right way round.
  const rotated = changesFromBase(
    mapK8sObjects([secret({ password: "b2xk" })]),
    mapK8sObjects([secret({ password: "bmV3" })]),
  );
  assert.equal(rotated.nodes.find((n) => n.id === "prod/Secret/db")?.change, "noop");

  // A key appearing is structure, not content, and structure we can review.
  const grown = changesFromBase(
    mapK8sObjects([secret({ password: "b2xk" })]),
    mapK8sObjects([secret({ password: "b2xk", token: "dG9r" })]),
  );
  const node = grown.nodes.find((n) => n.id === "prod/Secret/db");
  assert.equal(node?.change, "update");
  assert.deepEqual(node?.attribute_diff, [
    { key: "data.token", before: null, after: "(sensitive)" },
  ]);
});

test("pure: the same pair colours to a deep-equal graph every time", () => {
  const base = mapK8sObjects([deployment("api", "acme/api:1")]);
  const head = mapK8sObjects([deployment("api", "acme/api:2"), service("api")]);
  assert.deepEqual(changesFromBase(base, head), changesFromBase(base, head));
});
