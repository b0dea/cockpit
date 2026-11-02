---
"@b0dea/cockpit": patch
---

The guard again counts `npx --no cockpit` as the installed cockpit when the root `package.json` has a `directories` entry that declares no commands. `npm init` writes `directories.doc` in a root holding the `docs/` that `sync` creates, and that made every printed `npx --no cockpit` command prompt (and Codex and OpenCode refuse it) while `./node_modules/.bin/cockpit` was allowed. Only `bin` and `directories.bin` still disqualify npx.
