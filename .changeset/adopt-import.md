---
'@b00dea/cockpit': minor
---

New `cockpit adopt --import-guard <hook> --cases <file>` compares a team's existing PreToolUse guard with cockpit's. It replays each case through both hooks as the payload an agent tool sends, prints which commands both refuse, only the old guard refuses and only cockpit refuses, and proposes `[[guards.deny]]` entries for the old guard's gaps without writing them. The old hook runs once per case with a minimal environment and a timeout, so the command is a person's.

The `init` preview now lists what adopting takes over (committed agent settings and their hooks, Makefile targets that run Docker Compose) and what stays the repository's. A new guide, docs/migrating-an-existing-setup.md, covers moving a guard and a Makefile-driven Compose stack.
