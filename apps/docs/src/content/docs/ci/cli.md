---
title: CLI reference
description: "@asteriusit/cli — commands, flags, environment, exit codes and retry behaviour."
---

For whoever is debugging a pipeline step at eleven at night. `@asteriusit/cli`
is published on npm under the MIT licence with **zero runtime dependencies**,
and requires Node ≥ 20. There is no install step: `npx` fetches it.

It is a thin wrapper over a plain webhook. Everything it does — detect the git
context, validate the file, retry a blip, fail loudly — you could do yourself,
and the [raw contract](#without-the-cli) is stable enough to.

## Commands

| Command | Sends | Measured against |
| --- | --- | --- |
| `push-plan` | `terraform show -json` of a normal plan | A pull request, or a branch |
| `push-drift` | `terraform show -json` of a `plan -refresh-only` | A branch, never a pull request |
| `push-state` | The graph **derived locally** from a state file | The repository |

```sh
npx @asteriusit/cli push-plan  --file plan.json
npx @asteriusit/cli push-drift --file plan.json
npx @asteriusit/cli push-state --file terraform.tfstate
```

## Options

```text
--file <path>     the JSON to send (from `terraform show -json`)
--url <url>       webhook URL              (env: GROUNDPLAN_URL)
--token <token>   webhook secret           (env: GROUNDPLAN_TOKEN)
--branch <name>   override the detected branch
--sha <sha>       override the detected commit sha
--pr <number>     override the detected pull request number (push-plan only)
--dry-run         push-state only: write the payload locally, send nothing
--out <path>      push-state only: where --dry-run writes
--help            show this help
```

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `GROUNDPLAN_URL` | yes | The repository's webhook URL. `push-drift` and `push-state` derive their own endpoints from it — there is nothing extra to configure. |
| `GROUNDPLAN_TOKEN` | yes | The repository's webhook secret. Not needed by `push-state --dry-run`: demanding a credential to perform a local audit would be a strange way to ask for trust. |

Flags win over environment variables.

## Behaviour

**It validates before it sends.** A missing file, a file that is not JSON, or
JSON that is not a plan (no `format_version`, no `resource_changes`) fails
instantly with a message naming the problem, and **no request is made**. A
refresh-only plan that proposes a create, an update or a delete is refused by
`push-drift` locally, before the network, because it describes what your code
wants rather than what the cloud did.

**It retries what is worth retrying.** A network error or a `5xx` is retried up
to three times with exponential backoff (0.5s, 1s, 2s), and each retry is
announced on stderr. A `4xx` is not retried — a wrong token stays wrong.

**It fails loudly.** Exit code `0` on success, non-zero on any failure, so the
step goes red where somebody will see it. Silence is not a success mode.

## Exit codes and messages

| Situation | Exit | Message |
| --- | --- | --- |
| Success | `0` | A one-line summary of what was sent |
| Bad or missing file, wrong artefact type | non-zero | Names the file and what was wrong with it |
| `401` / `403` | non-zero | `authentication failed — check GROUNDPLAN_TOKEN matches this repository's webhook secret` |
| `404` | non-zero | `repository not found — check GROUNDPLAN_URL points at your repository's webhook endpoint` |
| `413` | non-zero | the payload is too large — %PRODUCT% accepts up to 10 MB |
| `422` | non-zero | The server's own explanation, passed through verbatim — it knows exactly what was wrong with the artefact |
| `5xx` or network, after retries | non-zero | `giving up after 4 attempts — <last error>` |

## Reading a payload before sending it

`push-state` is the one command that reads something as sensitive as a state
file, so it is the one command with an audit mode:

```sh
npx @asteriusit/cli push-state --file terraform.tfstate --dry-run
```

It writes the exact payload to `groundplan-state.json` (or `--out <path>`) and
sends nothing. Every run — dry or not — prints what it derived first:

```text
derived 214 resources and 388 relationships from terraform.tfstate (Terraform 1.9.5)
sending 1809 attributes; 2140 withheld (sensitive, secret-named, or not a plain value)
no sensitive value is included — the state itself is never sent
```

The filters behind those numbers are described on
[Drift & reality](/use/drift-and-reality/).

## Without the CLI

A runner with no Node, or a policy against `npx` in a pipeline: post it
yourself. The contract is stable.

```sh
curl -sf -X POST "$GROUNDPLAN_URL" \
  -H "X-Groundplan-Token: $GROUNDPLAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
        --arg ref "$GIT_BRANCH" \
        --arg sha "$GIT_SHA" \
        --argjson pr 42 \
        --slurpfile plan plan.json \
        '{ref:$ref, commit_sha:$sha, event:"pull_request", pr_number:$pr, payload:$plan[0]}')"
```

Drop `pr_number` and use `event:"push"` for a branch. The endpoint answers `202`
with what it accepted, caps the body at 10 MB, and `curl -sf` turns any failure
into a red step. Drift posts the same shape to `$GROUNDPLAN_URL/drift`.

The in-app CI setup panel shows this snippet filled in with your repository's own
URL, under **Advanced**.
