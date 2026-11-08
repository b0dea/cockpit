---
"@b00dea/cockpit": patch
---

Adoption into a pnpm repository and later upgrades no longer stall:

- A local-archive pin now verifies under pnpm 11 and later, which write the package manager's own lock as a first document in `pnpm-lock.yaml` when `package.json` names a `packageManager`. Before, init refused and a teammate's `check` asked for `pnpm install` in a loop.
- `upgrade` accepts `--json`, reads the latest version past notices that a wrapper around npm prints, names an unusable answer, and exits 0 with an `UPGRADE_ALREADY_CURRENT` info diagnostic when cockpit is already current.
- `selftest --write-probe-specifications` accepts `--json`, writes the file and names it.
- A terminal `yes` is accepted only while the preview it approves is shown on the terminal: stdin and stderr must both be one.
- The README, the setup procedure, a fix and the harness guide no longer tell people to type a digest that the yes/no prompt does not accept.
- The teammate guide shows the frozen install for npm, pnpm and yarn.
