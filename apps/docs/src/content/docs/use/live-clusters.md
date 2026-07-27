---
title: Live clusters
description: Draw a namespace from a running cluster with a read-only kubeconfig — and exactly what that access is used for.
---

For somebody who wants to see what is actually running, not what a repository
says should be. A live cluster is attached at the **organization** level, beside
Projects rather than inside one: a cluster has no pull request and no commit, so
it never belonged under a unit of code review.

This is the single place %PRODUCT% is given access to a running system, so this
page is blunt about what that access is and what it is used for.

## The one deliberate exception, bounded

Everything else in the product is fed by artefacts your pipeline produces. A
cluster read is different: you hand over a **kubeconfig**, and we use it. So it
is bounded on every side that can be bounded.

- **Encrypted at rest**, with the same AES-256-GCM machinery as repository
  tokens, and **write-only**: once stored, no interface and no API response ever
  returns it.
- **Reads are LIST only.** There is no `get` of an individual object anywhere in
  the reader, no write verb, and no `exec`.
- **Secret values are never fetched.** A `Secret` is mapped as a node with its
  name and metadata so the diagram can show that one exists; its data is never
  requested, never stored and never drawn.
- **On demand only.** Nothing is polled. A namespace is read when a person asks
  for it, and the resulting snapshot is dated.
- **Still no cloud credentials.** A kubeconfig is not a subscription. Nothing
  here reaches your cloud provider's API.

## Attach one

**Clusters → Attach cluster**, then paste a kubeconfig. It is verified
immediately — a cluster that cannot be reached, or a kubeconfig that is not
valid, is rejected at that moment rather than silently failing later.

Then pick a namespace and generate. The result is an ordinary snapshot,
diagrammed like any other, and dated with the moment it was read.

## Give it a read-only role

Create a dedicated service account with a role that can list, and nothing else.
This is what the reader actually uses:

```yaml title="groundplan-reader.yaml"
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: groundplan-reader
rules:
  - apiGroups: [""]
    resources:
      - namespaces
      - services
      - configmaps
      - secrets # names and metadata only — values are never fetched
      - serviceaccounts
      - persistentvolumeclaims
    verbs: ["list"]
  - apiGroups: ["apps"]
    resources: [deployments, statefulsets, daemonsets]
    verbs: ["list"]
  - apiGroups: ["batch"]
    resources: [jobs, cronjobs]
    verbs: ["list"]
  - apiGroups: ["networking.k8s.io"]
    resources: [ingresses, networkpolicies]
    verbs: ["list"]
  - apiGroups: ["autoscaling"]
    resources: [horizontalpodautoscalers]
    verbs: ["list"]
```

`list` on `secrets` is what lets the diagram show that a Secret exists and what
references it. If your policy forbids that verb on that resource, leave it out —
the read still works and the diagram simply will not show Secret nodes, with a
warning saying so. That is the general rule below.

Bind it to a service account, and build a kubeconfig from that account's token.
A namespaced `Role` works just as well when you only ever draw one namespace;
the `ClusterRole` above is only needed to list namespaces for the picker.

## Less access degrades honestly

A kubeconfig scoped to less than everything is the kubeconfig we ask for, so a
`403` on one kind is not a failure. That kind is **skipped**, a warning **names
it**, and the snapshot says out loud that it is partial.

A partial diagram that admits what is missing beats a hard error that explains
nothing — and beats a complete-looking diagram that quietly omits your
Ingresses.

## What it draws

One namespace at a time, from the kinds listed above: workloads, the services
and ingresses in front of them, the configuration and storage behind them,
network policies, and the autoscalers attached to them. Relationships come from
selectors, mounts and owner references.

Not drawn: pods (they are cattle, and a diagram of them is a diagram of the last
few minutes), custom resources, and more than one namespace at a time.

## Same limits as any Kubernetes snapshot

A cluster snapshot gets the diagram and the deterministic summary. No
annotations, no AI, no tours, no share links, and no network or IAM lens — the
reasons are the same ones on [Kubernetes manifests](/ci/kubernetes/#what-a-kubernetes-snapshot-does-not-get).

## Detaching

Delete the cluster and the kubeconfig goes with it. Rotating the service
account's token at the cluster invalidates our copy immediately — you do not
need us to be reachable, or cooperative, to revoke it.
