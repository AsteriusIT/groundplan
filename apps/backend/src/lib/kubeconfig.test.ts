import { test } from "node:test";
import assert from "node:assert/strict";

import { InvalidKubeconfigError, parseKubeconfig } from "./kubeconfig.js";

const VALID = `
apiVersion: v1
kind: Config
current-context: prod
clusters:
  - name: prod-cluster
    cluster:
      server: https://k8s.example.com:6443
contexts:
  - name: prod
    context:
      cluster: prod-cluster
      user: prod-user
      namespace: payments
users:
  - name: prod-user
    user:
      token: super-secret-token
`;

test("parses a valid kubeconfig into its current context", () => {
  const parsed = parseKubeconfig(VALID);
  assert.equal(parsed.currentContext, "prod");
  assert.equal(parsed.server, "https://k8s.example.com:6443");
});

test("a kubeconfig that is not YAML is rejected", () => {
  assert.throws(
    () => parseKubeconfig("\tthis: is: not: yaml: ["),
    InvalidKubeconfigError,
  );
});

test("a kubeconfig that is YAML but not a mapping is rejected", () => {
  assert.throws(() => parseKubeconfig("just a string"), InvalidKubeconfigError);
});

test("a kubeconfig without a current-context is rejected", () => {
  const noContext = VALID.replace("current-context: prod\n", "");
  assert.throws(() => parseKubeconfig(noContext), InvalidKubeconfigError);
});

test("a current-context naming a context that does not exist is rejected", () => {
  const dangling = VALID.replace("current-context: prod\n", "current-context: staging\n");
  assert.throws(() => parseKubeconfig(dangling), InvalidKubeconfigError);
});

test("a context whose cluster has no server is rejected", () => {
  const noServer = VALID.replace("      server: https://k8s.example.com:6443\n", "");
  assert.throws(() => parseKubeconfig(noServer), InvalidKubeconfigError);
});

// The message goes into a 422 body and into logs. A kubeconfig carries a bearer
// token or a client key, so nothing quoted from it can ever appear there.
test("the rejection message never quotes the kubeconfig", () => {
  const withSecret = VALID.replace("current-context: prod\n", "current-context: staging\n");
  try {
    parseKubeconfig(withSecret);
    assert.fail("expected a rejection");
  } catch (err) {
    if (!(err instanceof InvalidKubeconfigError)) throw err;
    assert.ok(!err.message.includes("super-secret-token"));
  }
});
