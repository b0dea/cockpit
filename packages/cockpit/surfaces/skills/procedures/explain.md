---
loading: pull
budget: uncapped
---

<!-- cockpit:verified version=0.0.0 -->

# Explain a cockpit

Run from the cockpit root. Invoke each cockpit command through the exact project-local
executable, `./node_modules/.bin/cockpit`, or through its `npx --no` form, such as
`npx --no cockpit check --config cockpit.toml`, which runs that same binary and never downloads
one. If the binary is absent, stop: do not use a command runner that can download a missing
package implicitly. The user guide this procedure cites is installed with cockpit: open each page
with a file read from `./node_modules/@b00dea/cockpit/docs/`. In Codex's sandbox only `check`,
`sync --dry-run` and `--help` run; ask the person to approve running any other cockpit command
outside the sandbox, or to run it in a terminal.

## Explain

Run only the read-only command that answers the question. Use `./node_modules/.bin/cockpit doctor --config cockpit.toml --json`
for environment health and wiring, `./node_modules/.bin/cockpit check --config cockpit.toml --json` for generated-surface
drift, or `./node_modules/.bin/cockpit preflight --config cockpit.toml --json` for dependency and readiness checks.
Combine them only when the question crosses those boundaries. When explaining drift, say what each
command does: `check` repairs nothing; `sync` rewrites a hand-edited generated artifact such as
`compose.generated.yml`, and refuses a hand-edited skill, agent settings file or cockpit-owned
region with `SURFACE_STATE_CONFLICT`. Explain the relevant installed lanes,
wired repositories, recorded reasons, current gaps and next accepted commands.
For a secret question, follow the *Secret handling* section of the cockpit-setup skill's procedure, `../../cockpit-setup/procedures/setup.md` from this file, and distinguish tracked schema, encrypted/provider
source, redacted status, trusted child injection and unavailable same-user read confinement.
