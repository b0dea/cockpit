# Shipped surfaces

<!-- cockpit:verified version=0.0.0 -->

These are the templates that `cockpit sync` renders into a consumer's checkout. They describe
that consumer's repositories, environment, guards and work contracts. This repository's own
tests and contributor configuration never become inputs to them.

## Rendering

Templates are filled from the resolved configuration: the sibling repositories, mount modes,
guard tables and configured harnesses. A generated skill therefore names that product's
repositories and commands instead of describing them generically.

cockpit merges the core templates with the consumer's overlays itself and hands the generator
one merged source, so merge behaviour does not change when the generator dependency changes.

## Golden behavior

Skill entry points are transformed per harness, because each harness uses different
frontmatter, tool names, paths and sidecar files. Their contract is the complete rendered
inventory plus the meaning checked by the skill contract.

Supporting files that need no harness-specific spelling stay byte-for-byte copies. The skill
contract compares every rendered copy of [skills/procedures/onboarding.md](skills/procedures/onboarding.md) with this source
for every harness.
