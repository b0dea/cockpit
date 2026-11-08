---
"@b00dea/cockpit": patch
---

Adoption into a pnpm repository and later upgrades no longer stall:

- A local-archive pin now verifies under pnpm 11 and later, which write the package manager's own lock as a first document in `pnpm-lock.yaml` when `package.json` names a `packageManager`. Before, init refused and a teammate's `check` asked for `pnpm install` in a loop.
- `upgrade` accepts `--json`, reads the latest version past notices that a wrapper around npm prints, names an unusable answer, and exits 0 with an `UPGRADE_ALREADY_CURRENT` info diagnostic when cockpit is already current or newer than the latest published version.
- `selftest --write-probe-specifications` accepts `--json`, writes the file and names it.
- A terminal `yes` is accepted only while the preview it approves is shown on the terminal: stdin and stderr must both be one.
- The README, the setup procedure, a fix and the harness guide no longer tell people to type a digest that the yes/no prompt does not accept.
- The teammate guide shows the frozen install for npm, pnpm and yarn.
- `env schema` on a schema that does not exist yet names how to create it with `--replace-from`.
- The setup procedure has agents confirm only the answers `unconfirmed` lists.
- `upgrade` runs and prints sync through the newly installed `./node_modules/@b00dea/cockpit/bin/cockpit.mjs` instead of `npx --no cockpit`, which the guard cannot prove under pnpm.
