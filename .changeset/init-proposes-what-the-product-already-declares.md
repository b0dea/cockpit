---
"@b0dea/cockpit": patch
---

`init` now proposes more of what the product's own files already declare, and `document` no longer writes undecided values as decisions.

- A repository with an `origin` remote in `.git/config` is proposed as `acquire = "auto"` with that `remote`, so a teammate's `setup` clones it. A URL that carries credentials is never proposed or shown, and a `.git` file (a worktree or submodule pointer) is not followed; both are reported with the file they came from.
- A Node lockfile proposes `toolchain = "node"`, and the reason names the `environment.install_policies` row that `setup` then requires.
- A final-stage Dockerfile `HEALTHCHECK` proposes a generated service `health` declaration. A `start`, `serve` or `dev` script proposes the service command, run by the package manager the lockfile selects, when no Dockerfile sets one.
- When a sibling's toolchain is left at its default, the reason names the lockfile that was read or the lockfiles that were looked for. It no longer says that nothing was observed.
- Each runnable-classification reason names its repository's file, so the reasons for several repositories can be told apart.
- `document` leaves `guards.hosted_db_hosts` and `guards.vendor_endpoint_hosts` out of the draft instead of writing `[]`, and reports each as a `DOCUMENT_GAP`. `doctor` therefore keeps warning `GUARD_HOSTS_UNDECLARED` until someone decides them. It also leaves out `workorders.verification_timeout_seconds` and `workorders.evaluator_timeout_seconds`, which no registry records; the loader applies their defaults.
- `document` on a registry cockpit reads the cockpit root's own Compose file. Its `${VAR:-port}` host ports become `ports.bases` and the file becomes `environment.compose_files`, both marked `[inferred]` with their source.
- The `environment.machine` question no longer claims that cockpit proposes the floor from the product's files. A person states it, and cockpit never proposes it.
