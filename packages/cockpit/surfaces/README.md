# Shipped surfaces

<!-- cockpit:verified version=0.0.0 -->

These are the authenticated neutral templates that `cockpit sync` renders into a consumer's
checkout. They describe that consumer's repositories, environment, guards, and work contracts.
Repository tests and contributor configuration are outside this estate and cannot become
generation inputs.

## Rendering

Templates are parameterised by the resolved configuration — the sibling registry, the mount
lanes, the guard tables, the harness set — so a generated skill names *that* cockpit's
repositories and commands rather than describing them generically.

Per the resolved overlay decision, cockpit resolves core plus the consumer's overlay itself
and hands the generator one merged source. Merge semantics are ours and do not change when a
dependency changes its own.

## Golden behavior

These files are the authenticated neutral sources consumed by `cockpit sync`. Native skill
entry points are deliberately transformed because each harness uses different frontmatter,
tool names, paths, and sidecars. Their contract is the complete rendered inventory and the
semantics checked by the skill contract.

Supplementary files that need no native spelling remain byte-for-byte goldens. The skill
contract compares every rendered copy of [skills/procedures/onboarding.md](skills/procedures/onboarding.md) with this source
for all three harnesses.
