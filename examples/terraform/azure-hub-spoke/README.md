# azure-hub-spoke — the network lens

A hub-and-spoke Azure estate: shared ingress and egress in the hub, a three-tier
application in one spoke, a second spoke written as a local module.

This is the example to open when you want to see **what the network view does
that a dependency graph cannot**.

## What it exercises

| Feature | Where to see it |
| --- | --- |
| `vnet ⊃ subnet ⊃ resource` containment | switch to `?view=network` — four network frames, every subnet showing its declared CIDR |
| Resource stacking | `azurerm_lb.web` draws its probe, rule and backend pool *inside* it; the public IP stacks on the bastion, the NAT gateway and the load balancer |
| VM placement through its NIC | a VM never references a subnet — `vm-app` lands in `snet-app` because its NIC's `ip_configuration` does, and the NIC nests inside the VM |
| Association resources as chips, not boxes | the NSG and route table associations disappear from the network view; the NSG rides on its subnet as a header chip |
| Peering collapsed to one edge | two `azurerm_virtual_network_peering` resources, one line between `vnet-hub` and `vnet-app` |
| Internet exposure | `nsg-web` allows 443 inbound from `Internet`, so it and everything it is associated with are drawn exposed and carry the `Exposed` badge |
| Module boxes | `module.analytics` is one box on the infra view and a nested `vnet → subnet → vm` chain on the network view |
| `count` on a static parse | `azurerm_linux_virtual_machine.app` shows `count = 2` as an attribute — one node, because static parsing never invents instances |

## What the parser produces

41 nodes, 71 edges (65 `depends_on`, 6 `contains`), 25 of them nested. No
warnings, no unresolved references.

## Policy

**Deliberately not clean.** One error: `nsg-open-to-internet` on
`azurerm_network_security_group.web`. That rule firing is the point — it is the
same finding the `Exposed` badge shows, said as a policy. For an estate where
every rule passes, use [`azure-policy-clean`](../azure-policy-clean).

Note that this stack tags through `tags = local.tags`. The built-in
`required-tags` rule (off by default) reads a literal `tags = { … }` block, so it
reports the tag keys as missing here — see the note in the
[top-level README](../README.md#known-rough-edge-required-tags-and-tags--localtags).
