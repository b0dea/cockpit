---
"@b00dea/cockpit": minor
---

Initial public release.

- One validated `cockpit.toml` declares a product's sibling repositories, services, ports, guards and MCP servers. `cockpit sibling add` and `cockpit sibling remove` edit the repository list for you.
- `cockpit sync` generates the Docker Compose stack and agent instructions, skills, subagents, hooks and permissions for Claude Code, Codex CLI and OpenCode, with `--dry-run` previews. Cursor and Grok Build files are generated but not yet verified against those tools.
- `cockpit sync --adopt <path>` moves a team's existing agent settings file into cockpit and merges it with the generated version instead of overwriting it.
- Three environment modes: generated (cockpit writes the Compose stack), compose-first (cockpit runs your own Compose files) and surfaces-only (agent files only, no stack).
- `cockpit check` fails when a generated file no longer matches the configuration, locally or in CI. The `cockpit-check` GitHub Action in this repository (`.github/actions/cockpit-check`) runs it against the version your lockfile installs.
- `setup`, `up`, `session`, `sleep`, `down`, `reset`, `preflight`, `doctor` and `logs` run the stack on your live checkouts, with port leases and holders so one agent cannot stop another agent's stack.
- `down` and `reset` pick the active local Docker context themselves and refuse one that is not local.
- `[ports.bases]` declares the published ports, and an optional hostname gives a service a named local address such as `https://app.sample.localhost:<port>/`. Editing `[ports.bases]` while the stack is up is recoverable with `down`, then `up`.
- Several cockpits run by the same user on one machine reserve separate port ranges, so their stacks never get the same ports.
- Generated stacks declare data modes (`empty`, `seeded`, `restored`) that decide what data `up` starts with. Test personas come from one declared source file.
- Each repository's tracked `.env.schema` declares its variables, and their resolver files live in one central directory in the cockpit. `preflight` and `doctor` validate each schema with Varlock when it is installed, without reading values.
- One guard policy refuses pushes to protected branches, reads and edits of declared environment files and secrets directories, and commands against declared hosted databases or vendor hosts. `[[guards.deny]]` and `[[guards.allow]]` add your own command rules on top. The hook is installed for Claude Code, Codex CLI and OpenCode and fails closed when it runs. It also denies agent writes to `.npmrc`.
- Codex runs the guard hook only after a person trusts it once per machine (`codex -C <cockpit root>`, then "Trust all and continue"); `doctor` and `check` report `CODEX_HOOK_UNTRUSTED` until then.
- OpenCode's native read, grep and glob tools go through the guard.
- `cockpit selftest` checks that each agent tool really enforces the generated controls.
- `cockpit runtime measure` measures the local Docker runtime and records the result for this machine only, in the git-ignored `.cockpit/local/runtime-measurements.json`; `cockpit.toml` never changes.
- Teams share one cockpit: the root `package.json` pins the exact cockpit version, `check` refuses a different running version, and cockpit manages its own block in `.gitignore`.
- `cockpit init` starts a cockpit from scratch or from an existing shell-based setup, marking every inferred value for review. Init answers carry their provenance: an answer `[provenance]` marks as inferred stays listed under `unconfirmed`, and `doctor` reports `DECLARATION_UNCONFIRMED` until a person confirms it.
- `init` always asks for `cockpit.name`, and renaming a cockpit is supported: `down`, edit the name, `sync`.
- The package ships the user guide under `docs/`.
- Shipped skills tell agents how to set up, explain, fix and work in a cockpit, and how to run browser checks. Install the adoption skill with `npx skills add b0dea/cockpit --skill adopt-cockpit`.
- Experimental: work orders graded by a separate evaluator, and browser checks.
- Runs on macOS and Linux. Native Windows is refused at startup; WSL2 should behave like Linux but is untested.
