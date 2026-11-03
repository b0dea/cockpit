---
"@b00dea/cockpit": patch
---

`cockpit upgrade [<version>] [--dry-run] --config <path>` moves the exact pin in one command: it resolves the latest published release (or the version you name), installs it as an exact dev dependency with the package manager the cockpit root's single lockfile names (npm, pnpm or yarn), runs `sync` in a new process so the new version renders, and prints the `Upgrade:` lines from the installed changelog between the two versions. It refuses with a named code when the registry is unreachable, the version is invalid, the target is not newer than the installed version, or the lockfile is missing or ambiguous. `--dry-run` prints the install and sync commands without running them. An agent may run `upgrade` exactly where `[autonomy] sync` lets it run a writing `sync`, and its sync child decides stale removals by `[autonomy] stale_delete`; `--dry-run` writes nothing and is never gated, for `upgrade` and `sync` alike.
