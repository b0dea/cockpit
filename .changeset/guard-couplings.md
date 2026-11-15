---
"@b00dea/cockpit": patch
---

A Node upgrade or a second Node install no longer holds guarded calls. The hook runs Node by the path `sync` found on your search path, such as a package manager's link, and the guard runs under whichever Node is there. `doctor` no longer reports that the Node differs.

The guard no longer tries to prove which cockpit a launcher starts. `cockpit`, `npx --no cockpit`, `./node_modules/.bin/cockpit` (pnpm's shim included) and `node <path>/cockpit.mjs` under any Node all count as cockpit, from any directory, and `doctor` no longer warns about an unproven launcher. The guard still asks before the cockpit commands that change what agents may do or wait for a person: `sync` and `upgrade` (unless `--dry-run`, or `[autonomy] sync = "agent"`), `reset`, browser commands without preapproval, `setup --write-instruction-*`, an operator-gated `--profile`, `use` of a checkout outside the configured roots, `--interactive`, `init`'s answer and scaffold flags, `sibling add`, `sibling remove` and `tool remove`. Every other cockpit command runs as any program does, and reports a wrong option or service itself.

The package no longer ships the native evidence validator left over from the removed `selftest`.

Upgrade: run `cockpit sync` once in a terminal, as after every release.
