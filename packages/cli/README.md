# @asteriusit/cli

Send a Terraform `plan.json` to [Groundplan](https://github.com/AsteriusIT/groundplan)
from your CI pipeline. It owns the integration ergonomics — git-context detection,
validation, retries — so the webhook contract stays simple and stable.

## Usage

Run it after `terraform plan`, with no install step:

```sh
terraform show -json plan.out > plan.json
npx @asteriusit/cli push-plan --file plan.json
```

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

```
--file <path>     the plan.json to send (from `terraform show -json`)
--url <url>       webhook URL              (env: GROUNDPLAN_URL)
--token <token>   webhook secret           (env: GROUNDPLAN_TOKEN)
--branch <name>   override the detected branch
--sha <sha>       override the detected commit sha
--pr <number>     override the detected pull request number
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
