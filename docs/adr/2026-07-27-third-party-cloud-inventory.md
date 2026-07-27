# ADR: ingesting third-party cloud inventories — restricted GO, deferred

- **Status:** Accepted (decision recorded; no product code in this story)
- **Date:** 2026-07-27
- **Story:** GP-210 (spike, time-boxed; the third volet of GP-205)
- **Supersedes nothing. Depends on:** GP-208 (reality snapshot), GP-209 (reality vs code)

## Context

GP-205 asks how Groundplan reconciles code with what actually exists, **without
ever holding cloud credentials**. Two volets shipped:

- **GP-206/207** — drift, from a `terraform plan -refresh-only` the user's own
  pipeline runs.
- **GP-208/209** — reality, from a state the user's CLI parses and sanitises
  locally.

Both share one shape: *the party that already has the access does the reading,
and we ingest the artefact.* It is the same arrangement as ingesting a plan.json
instead of running `terraform`, and rendered manifests instead of running `helm`.

Both also share one blind spot. A state file only knows about resources
Terraform created. A resource somebody clicked into existence in the portal, in a
subscription nobody has ever put under IaC, is invisible to both — it is in no
state and no plan. That is the gap this spike is about: **shadow IT, orphaned
resources, and the true audit perimeter.**

The tempting answer is a cloud scanner. It is also the one answer this product
must never give: a scanner needs credentials, and "we ingest data, not access" is
not a feature we are trading away. So the question is narrower and more
interesting: *can we ingest the exports of inventory tools the user runs
themselves?*

## What was evaluated

Candidates, judged on maintenance, licence, format stability, and how much of a
`GraphSnapshot` their output can honestly fill.

| Tool | Licence | Maintenance | Export | Verdict |
| --- | --- | --- | --- | --- |
| **Azure Resource Graph** (`az graph query`) | Native Azure API, no third party | First-party, versioned, stable | JSON rows, arbitrary KQL projection | **Best fit.** No extra tool for the user to adopt, no third-party licence, and the caller controls the projection — which means the caller controls what leaves their tenancy. |
| **Steampipe** | AGPL-3.0 (core) | Active; Turbot's commercial focus has moved to Tailpipe/Powerpipe | SQL → CSV/JSON | Workable. AGPL on the engine is the *user's* concern, not ours (they run it), but adopting a query language and a plugin matrix is real surface. |
| **CloudQuery** | Source-available (ELv2) since 2023; plugins vary | Active, commercial | Postgres/Parquet/JSON | Powerful and genuinely multi-cloud, but the ELv2 relicensing and the plugin-per-provider model make the ingestion contract a moving target. |
| **AWS Config** | Native AWS | First-party | Configuration snapshots to S3 | The AWS analogue of Resource Graph, but delivery is asynchronous via S3, which adds a fetch step we would rather not own. |
| **driftctl** | Apache-2.0 | **Archived / maintenance mode** (Snyk, 2023) | JSON | **No.** Its whole job was this comparison, and it was abandoned. That is a data point about the shape of the problem, not just about one project. |

### Can an export be mapped to a `GraphSnapshot`?

Partially, and the partiality is the whole finding.

- **Identity.** An inventory row is keyed by a **cloud resource id**
  (`/subscriptions/…/resourceGroups/rg/providers/…`), not a Terraform address.
  Every other node in this product is anchored to a Terraform address —
  annotations, policy violations, waivers all hang off it (GP-55, GP-200,
  GP-204). An inventory node cannot join that namespace.
- **Correlation is possible but incomplete.** A state's `attributes.id` *is* the
  cloud id for most azurerm resources, so `cloud id → Terraform address` can be
  built **from the reality snapshot GP-208 already produces**. That correlation
  covers exactly the resources Terraform manages — which are the ones we already
  know about. For the resources this feature exists to find, there is by
  definition no Terraform address, and there never will be.
- **Dependencies are largely unavailable.** Resource Graph returns properties,
  not a dependency graph. Some edges are reconstructible from id references
  inside properties (a NIC's `subnet.id`), which is the join-catalogue work of
  GP-41/GP-89 done a second time against a second schema. Most relationships
  simply are not in the export.
- **Sanitisation.** Inventory exports carry properties, not secrets: no state,
  no outputs, no provider credentials. Some resources do expose connection
  metadata, so the filtering posture would be GP-208's, applied client-side in
  the CLI for the same reason.

### What it would actually add

Over GP-208/209: **resources outside every state**. That is a real and valuable
question — shadow IT, leftovers from a decommission, an audit perimeter nobody
can enumerate. It is also a different product surface: those resources have no
address, no code, no owner, and no pull request. They cannot be annotated,
policed, waived or reviewed the way everything else here can.

## Decision

**Restricted GO, deferred.** Not now, and when it happens, in exactly this shape:

1. **Producer E is Azure Resource Graph only, v1.** One provider, one tool,
   consistent with the product's Azure-first depth (GP-41..GP-49). Not
   CloudQuery, not Steampipe: adopting a third-party engine's plugin matrix as an
   ingestion contract is a maintenance liability we would carry forever, and
   Resource Graph asks the user to adopt nothing they do not already have.
2. **`groundplan push-inventory`**, following GP-208 exactly: the user runs
   `az graph query`, the CLI filters and shapes locally, `--dry-run` prints the
   payload, only the derived graph is sent. No new trust posture, no new
   credential, no new promise.
3. **Inventory nodes are a distinct kind, not graph nodes.** They are keyed by
   cloud id, they carry no Terraform address, and they must not enter the
   snapshot namespace that annotations, policies and waivers anchor to. They
   correlate to Terraform addresses through the reality snapshot where they can,
   and are listed as **unattributed** where they cannot. This is the load-bearing
   constraint: the moment an inventory row is allowed to look like a graph node,
   every anchored feature in the product acquires a class of node it cannot
   honestly answer for.
4. **The v1 surface is a list, not a lens.** "Resources in this subscription that
   no state and no repository accounts for", with a scope and a timestamp. The
   diagram is not the right output for a set of things with no known
   relationships — drawing them as unconnected cards would suggest we looked for
   edges and found none, when we never had them to look for.

### Why deferred rather than scheduled

GP-208/209 answer the same *question* — "what exists that the code does not
describe?" — for everything under Terraform management, which is where the
reviewable estate is. Producer E extends the answer to resources nobody has ever
put under IaC. That is worth building **once GP-208 is in real use and users say
the remaining gap matters**, and not before: a whole producer, a new node kind
and a new page, justified by a gap nobody has yet reported, is how a roadmap gets
heavy.

Nothing here is blocked by this decision. GP-209's view is complete on its own
terms, and Producer E slots beside it whenever the demand is real.

## Consequences

- No product code in GP-210. The deliverable is this ADR.
- No new stories opened. When demand appears, the epic is: producer + CLI
  command (1), inventory node model + correlation through the reality snapshot
  (1), the unattributed-resources page (1).
- **The trust model is untouched, and every option considered honoured it.** No
  candidate above requires Groundplan to hold a cloud credential; the ones that
  would have (a built-in scanner) were never on the list.
- driftctl's archival is recorded here deliberately: the next person to propose
  "just use an off-the-shelf drift tool" should see that the best-known one was
  abandoned, and that GP-206's refresh-only approach was chosen partly because it
  depends on nothing but Terraform itself.
