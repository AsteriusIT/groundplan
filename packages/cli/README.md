# @asteriusit/cli

Send what your pipeline knows to
[Groundplan](https://github.com/AsteriusIT/groundplan). It owns the integration
ergonomics — git-context detection, validation, retries — so the webhook contract
stays simple and stable.

## Usage

Run it after `terraform plan`, with no install step:

```sh
terraform show -json plan.out > plan.json
npx @asteriusit/cli push-plan --file plan.json
```

### Drift

`push-drift` sends a **refresh-only** plan: what changed in the cloud without
anybody asking Terraform to. Groundplan holds no cloud credentials, so the
refresh happens where the access already is — in your pipeline.

```sh
terraform plan -refresh-only -out=tfplan
terraform show -json tfplan > plan.json
npx @asteriusit/cli push-drift --file plan.json
```

A refresh-only plan plans nothing, and that is enforced: a file proposing a
create, update or delete is refused before any request is made, because it says
what your code wants rather than what the cloud did. A measurement with no drift
is still worth sending — "clean as of an hour ago" and "nobody looked" are
different answers.

It is measured against a branch, never a pull request, and it uses the same two
variables as `push-plan` (the drift endpoint is derived from `GROUNDPLAN_URL`).
Run it on a schedule; nightly is a good default. Example cron jobs for GitHub
Actions, GitLab CI and Azure DevOps are in
[`docs/drift.md`](https://github.com/AsteriusIT/groundplan/blob/main/docs/drift.md).

### Reality

`push-state` sends a picture of what actually exists — including resources
created by hand, which no plan can see.

**Your state file never leaves your machine.** A state holds every password and
key your configuration touched, so the parsing and the sanitising happen here, in
this CLI, and only the derived graph is sent. Post a raw state at the API and it
is refused.

```sh
terraform state pull > terraform.tfstate
npx @asteriusit/cli push-state --file terraform.tfstate
```

Read exactly what would be sent, before sending it — `--dry-run` writes the
payload to `groundplan-state.json` (or `--out <path>`) and needs neither URL nor
token:

```sh
npx @asteriusit/cli push-state --file terraform.tfstate --dry-run
```

Three filters run over every attribute: anything Terraform flagged sensitive,
anything whose name looks like a secret, and anything that is not a plain string,
number or boolean — nested structures are dropped entirely rather than
summarised, so a secret buried inside one cannot escape. Outputs are never sent.
Full details, the residual risk, and an example job:
[`docs/reality.md`](https://github.com/AsteriusIT/groundplan/blob/main/docs/reality.md).

Configure it with two environment variables (both shown on the repository's CI
setup page in Groundplan):

| Variable | What it is |
| --- | --- |
| `GROUNDPLAN_URL` | Your repository's webhook URL |
| `GROUNDPLAN_TOKEN` | Your repository's webhook secret |

The branch, commit sha, and pull-request number are detected from the git
checkout and common CI environment variables (GitHub Actions, GitLab CI, Azure
DevOps), including detached-HEAD CI checkouts. Override any of them with a flag.

### Options

```text
--file <path>     the JSON to send (from `terraform show -json`)
--url <url>       webhook URL              (env: GROUNDPLAN_URL)
--token <token>   webhook secret           (env: GROUNDPLAN_TOKEN)
--branch <name>   override the detected branch
--sha <sha>       override the detected commit sha
--pr <number>     override the detected pull request number (push-plan only)
--help            show this help
```

## Behaviour

- **Validates locally first.** A missing file, non-JSON, or a file that isn't a
  plan (`format_version` / `resource_changes`) fails instantly with a clear
  message and a non-zero exit — no request is made.
- **Retries transient failures.** A 5xx or a network error is retried up to three
  times with exponential backoff; a 4xx (bad token, unknown repo, oversized plan)
  fails fast with an actionable message.
- **Exit codes.** `0` on success, non-zero on failure, so a CI step fails visibly.

Requires Node ≥ 20. No other runtime dependency.
