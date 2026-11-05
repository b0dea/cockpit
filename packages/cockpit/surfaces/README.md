# Shipped surfaces

<!-- cockpit:verified version=0.0.0 -->

These are the templates that `cockpit sync` renders into a consumer's checkout. They describe
that consumer's repositories, environment, guards and work orders. This repository's own
tests and contributor configuration never become inputs to them.

## Rendering

Templates are filled from the resolved configuration, so a generated skill names that product's
repositories and commands. cockpit merges the core templates with the consumer's overlays itself and hands the generator
one merged source, so a generator upgrade cannot change how the merge works.

## Golden behavior

Skill entry points are transformed per harness, because each harness uses different
frontmatter, tool names, paths and sidecar files. Their contract is the full list of rendered
files plus the meaning that the skill contract checks.

Supporting files that need no harness-specific spelling stay byte-for-byte copies. Each shipped
skill carries only its own procedure from [skills/procedures/](skills/procedures/), named by the
`procedure` field of its entry point; the skill contract compares every rendered copy with its
source for every harness. Steps two skills need, such as secret handling, live in the setup
procedure and the others point to it.

References under `references/` are pulled on demand. `cockpit-setup` carries the test-data
reference beside its entry point; it sits outside the skill contract because the
contract covers only entry points and their procedures. `cockpit-browser` reads the test-data
reference through its sibling skill instead of carrying a second copy.
