---
"@b00dea/cockpit": patch
---

Agents can read outside the cockpit where a person allows it, in one of three ways:

- **`[guards] read_paths`:** list the folders or files agents may read, such as `~/Downloads`. Agents can read, list and search named files there.
- **`[guards] external_reads = "native"`:** hand named reads outside the cockpit to each agent tool's own permissions.
- **Exact command:** admit one command by its complete argv with an explicit working directory under `guards.allow`. This also covers a read-only Git command in a related checkout, such as `git -C <checkout> status --short`.

In every mode, the guard refuses secret names, writes outside the cockpit, links, and recursive searches or comparisons (`git diff <dir> <dir>`) of external directories. A native permission still wins over cockpit's allow.

The guard also allows `git worktree list`, direct `shasum` hashing, and reads of package documentation through links that stay inside the checkout. Refusals now say whether a location lacks a grant, a command cannot be proven read-only, or a write is never grantable. A refused `node --test` verifier names the two ways to keep its runner.

Closed gaps:
- `shasum +c` reached check mode through Perl's `+` option prefix.
- A `guards.allow` rule admitted secret names in arguments the guard could not classify, such as `cat README.md .env -x` or `git show HEAD:.env`. Reading commands and Git are now denied; another command naming one, such as `docker compose --env-file .env up`, now asks instead of running.
- A rule could admit a search the guard had found would read an environment file.
- A rule for a reading command could admit paths outside the cockpit.

Upgrade: a person adds `read_paths` or sets `external_reads` and runs `cockpit sync`. Re-review any existing rule whose command now asks.
