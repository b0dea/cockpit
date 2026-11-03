---
"@b00dea/cockpit": patch
---

`init` now proposes more of what the product's own files already declare.

- A repository with an `origin` remote in `.git/config` is proposed as `acquire = "auto"` with that `remote`, so a teammate's `setup` clones it. A URL that carries credentials is never proposed or shown, and a `.git` file (a worktree or submodule pointer) is not followed; both are reported with the file they came from.
- A Node lockfile proposes `toolchain = "node"`, and the reason names the `environment.install_policies` row that `setup` then requires.
- A `start`, `serve` or `dev` script proposes the service command, run by the package manager the lockfile selects, when no Dockerfile sets one.
- When a sibling's toolchain is left at its default, the reason names the lockfile that was read or the lockfiles that were looked for. It no longer says that nothing was observed.
- Each runnable-classification reason names its repository's file, so the reasons for several repositories can be told apart.
- The `environment.machine` question no longer claims that cockpit proposes the floor from the product's files. A person states it, and cockpit never proposes it.
