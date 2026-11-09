---
"@b00dea/cockpit": patch
---

`selftest` reports what it measured more truthfully:

- Instruction loading is measured on the whole root `AGENTS.md` the tools load, your own text included, not only cockpit's region, so a team guide that pushes cockpit's text past Codex's size limit now fails that cell instead of passing.
- With no `[guards] vendor_endpoint_hosts`, the Claude Code guard-firing cell is pending as the new `guard_host_undeclared`, telling you to declare a host, instead of being blamed on a missing protocol. Cells cockpit cannot measure, such as Codex guard firing, say plainly that they stay pending.
- `summary.complete`, which could never be true, is replaced by `summary.measurementComplete`: true only when every cell with a supported protocol produced evidence. Skill reviews are listed beside it as a person's judgement that cockpit cannot perform or record.
- The interactive approval shows each command once per skill template with the skills it runs for, and shows any row that template does not reproduce exactly in full; you still approve the same file digest.

`sync` now copies a sibling guide's `@` import of a file the sibling holds as a plain path from the cockpit root, since in the cockpit root it named the wrong file or none; package names and handles are copied as written. `doctor` reports `GUARD_NODE_DIFFERS`: as information when the guard hook runs a different Node than the command, and as a warning when the Node at the recorded path changed in place, which holds the guard's calls until `sync` runs again.

In a cockpit whose probe-specification file was written before this release, write a fresh one as `selftest` asks.
