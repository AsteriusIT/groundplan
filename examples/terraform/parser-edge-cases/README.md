# parser-edge-cases — diagnostics and awkward syntax

The example for testing what happens when the Terraform is *not* clean: a file
that does not parse, four references that point at nothing, and a pile of syntax
a naive brace-counter would choke on.

> ⚠️ This folder deliberately contains a file that is not valid HCL
> (`broken.tf`). `terraform fmt`, `terraform validate` and `terraform init` will
> all fail here. That is the point — do not "fix" it.

## Verified result

12 nodes, 15 edges, **1 error and 4 warnings**:

```
error    broken.tf: unbalanced braces
warning  unresolved reference 'azurerm_subnet.renamed_last_week.id'      from azurerm_network_interface.dangling
warning  unresolved reference 'module.networking.location'               from azurerm_public_ip.from_missing_module
warning  unresolved reference 'data.azurerm_client_config.current.…'     from azurerm_key_vault.missing_data_source
warning  unresolved reference 'azurerm_subnet.decommissioned'            from azurerm_route_table.commented
```

Each warning carries the file and the line span of the block it came from, so
the VS Code extension can put it in the Problems panel and jump to it.

## What to check

**One bad file does not take the diagram down.** `broken.tf` is skipped whole —
both of its resources are missing from the snapshot, including the one that was
fine — and the other three files still produce a graph.

**A dangling reference is a missing edge, not a missing node.**
`azurerm_network_interface.dangling` is in the diagram; it simply has no line to
the subnet it names.

**Syntax that must not break the scan** (all in `expressions.tf`): a heredoc full
of JSON braces, a string containing `{`, a block comment containing a
resource-shaped token, a `dynamic` block, `for_each`, `count`, and top-level
`moved` / `check` blocks. None of them becomes a node, and everything real does.

**`count` vs `for_each`.** `azurerm_public_ip.counted` records `count = 3` as an
attribute and draws **one** node — a static parse never invents instances.
`azurerm_subnet.per_each` records no count, because `for_each = local.subnets`
cannot be resolved without evaluating it: absent rather than wrong.

**A `dynamic "security_rule"` block yields no rules.**
`azurerm_network_security_group.dynamic` carries no rule payload and therefore no
exposure verdict. Worth knowing: an NSG whose rules are generated is *unknown*,
not *safe*, and no badge appears either way.

## Two known quirks this example pins down

1. **References in comments are reported.** The `# TODO:` line in
   `azurerm_route_table.commented` mentions `azurerm_subnet.decommissioned`, and
   that produces an unresolved-reference warning. The parser extracts
   reference-shaped tokens from the whole block body; telling code from prose
   would mean a full expression parser. It is a deliberate trade, but it does
   mean a stale comment can generate a diagnostic.

2. **A CIDR inside a function call is read as the literal.**
   `azurerm_subnet.per_each` declares
   `address_prefixes = [cidrsubnet("10.80.0.0/16", 8, …)]` and the snapshot
   records `address_prefixes = 10.80.0.0/16` — the function's *argument*, which
   is the whole network rather than the subnet's slice of it. On the network
   lens that CIDR is shown on the subnet's header. Passing a variable instead
   (`cidrsubnet(var.address_space, …)`, as `multi-module-monorepo` does) records
   nothing at all, which is the honest outcome.

## Policy

`passing` — nothing here is insecure, it is just awkward. The point of this
example is the diagnostics channel, not the rules.
