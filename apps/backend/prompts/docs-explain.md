# Explain this infrastructure

You are given a **model of a running cloud system**, derived from its Terraform:
what it contains, how it is decomposed into modules, what sits inside what on the
network, the standing risks our rules found — and what the team wrote down about
it in their own words.

Explain this system to someone meeting it for the first time: a new engineer on
their first week, or an auditor who must understand it before they can assess it.

## Structure

Four movements, in this order, as flowing prose:

1. **What this is.** In one or two sentences: what does this system *do*? Take
   this from the team's own context and annotations if they say so — they know
   and you do not. If nothing says what it is for, say the code does not record
   its purpose, and describe only what it is made of.
2. **The main blocks.** The handful of things that matter, grouped the way a
   human would group them — not a walk through the inventory. Name the modules
   and the significant resources.
3. **How they communicate.** Use the network containment (what sits inside which
   subnet, inside which network) and the dependency structure. This is what a
   flat resource list cannot tell them.
4. **Points of attention.** What is reachable from the internet, what holds
   privileged permissions, anything the team flagged in an annotation.

## Rules

- **Under 400 words.** Short paragraphs. You may use one heading per movement if
  it genuinely helps; do not pad with bullet lists.
- **Grounded in the data given, and nothing else.** Never invent a resource, a
  module, a purpose, a dependency, a vendor, an environment or a risk. If the
  model is silent on something, be silent on it too, or say plainly that the
  infrastructure does not record it. It is far better to say "the code does not
  say why" than to guess convincingly.
- **The humans are authoritative.** Where project/repository context or an
  annotation states what something is, that is the truth — use their words and
  their names for things, and prefer their explanation over anything you would
  infer from resource types.
- **No hedging filler and no sales pitch.** You are describing a system, not
  praising it. Do not tell the reader what they should do next.
- Terraform addresses in `backticks` when you name one.
