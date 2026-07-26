# multi-module-monorepo — entrypoints and module nesting

One repository, two independent stacks, three shared modules, one of which calls
another. Nothing about the infrastructure is interesting; the *layout* is.

```
modules/
  network/         vnet + 2 subnets + nsg          (used by both stacks)
  workload/        web app + storage + private endpoint
    └── calls modules/observability/               (a module inside a module)
stacks/
  platform/        rg + module.network + module.workload
  sandbox/         rg + module.network
```

## What it exercises

**`terraform_path` / `rootDir` selects the entrypoint, not the file set.** Attach
this repository three ways and watch the answer change:

| `terraform_path` | Result |
| --- | --- |
| `stacks/platform` | 16 nodes, 25 edges — the platform stack and everything it reaches |
| `stacks/sandbox` | 7 nodes, 10 edges — the sandbox stack only; the platform stack does not appear |
| *(empty — the repo root)* | **0 nodes.** The root holds no `.tf` file, so the parse starts and stops there |

Modules sourced from *above* the configured root (`../../modules/network`)
resolve normally — the root says where the parse starts, the way `terraform
-chdir` does.

**Module nesting.** `module.workload` calls `module.observability`, so its
resources land at `module.workload.module.observability.*` with a two-segment
module path. On the infra view that is a box inside a box.

**Containment survives a module boundary — when the references do.** Look at the
platform stack: `module.network`'s vnet, subnets and NSG chip nest exactly as
they would at the root, because those resources reference each other directly.
`module.workload`'s web app and private endpoint do **not** nest into those
subnets, because they receive `var.app_subnet_id` — and a static parse cannot
follow a variable back to the resource that produced it. The relationship is
still in the diagram, carried by the `module.network → module.workload` edge.
That contrast, in one repository, is the reason this example exists.

## Policy

`warnings` — five `required-tags` findings on the platform stack, and only
because both stacks tag through `local.tags` / `var.tags`. That is the rough edge
described in the [top-level README](../README.md#known-rough-edge-required-tags-and-tags--localtags),
reproduced here on purpose: it is the single most common way real Terraform tags
resources, so it is worth having an example that shows what the rule does with
it. Enable `required-tags` (it is off by default) to see them. Every other rule
is silent.
