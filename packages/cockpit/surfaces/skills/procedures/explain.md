---
loading: pull
budget: uncapped
---

<!-- cockpit:verified version=0.0.0 -->

# Explain a cockpit

## Running cockpit

- Run every command from the cockpit root, the directory holding `cockpit.toml`, through the
  project-local binary, for example `./node_modules/.bin/cockpit check --config cockpit.toml`.
  `npx --no cockpit <command>` starts the same binary, but the path form still runs where the
  guard cannot prove what npx starts. If the binary is missing, stop and ask the person to install cockpit; a
  runner that downloads a package is never a substitute.
- Take flags from each command's `--help`. With `--json`, read `result`, `diagnostics[].code` and
  `invocation.exitCode`. Every diagnostic names its fix, and
  `./node_modules/@b00dea/cockpit/docs/troubleshooting.md` covers the codes that need more; the
  other user-guide pages cited here sit beside it.
- When the guard asks before a command, the person decides in Claude Code; Codex and OpenCode deny
  instead, so hand the person the exact command to run in a terminal. A refusal that holds every
  guarded tool call (a guard message saying so, `GUARD_AUTHORITY_UNAVAILABLE` or `GUARD_CONFIG_UNSYNCED`)
  follows any edit to `cockpit.toml` or reinstall of cockpit or Node. `GUARD_CONFIG_UNSYNCED` means
  the edit does not widen what agents may do, so run
  `./node_modules/.bin/cockpit sync --config cockpit.toml` yourself where `[autonomy] sync =
  "agent"`; any other hold clears only when a person runs it in a terminal. A refused command is the
  person's to run: never reword, wrap or re-spell it to get past the guard.
- In Codex's sandbox only `check`, `sync --dry-run` and `--help` work. Every other cockpit command
  there cannot read cockpit's state or the Docker socket, so a failure it reports is not evidence:
  ask the person to approve running it outside the sandbox, or to run it in a terminal. Under
  `codex exec`, which cannot ask, a person runs it.
- Ask, never invent. A port, image, command, host, purpose, name, version, role or credential comes
  from a file you read or from the person; with neither, name the gap and ask.

## Explain

You answer a question about this cockpit from what its commands report now, and change nothing.

1. **Pick the command that answers the question**, and only that one:
   `./node_modules/.bin/cockpit doctor --config cockpit.toml --json` for environment health, wiring
   and readiness gaps; `./node_modules/.bin/cockpit check --config cockpit.toml --json` for generated
   files that drift from `cockpit.toml`; `./node_modules/.bin/cockpit preflight --config cockpit.toml --json`
   for whether the environment passes the gate work needs;
   `./node_modules/.bin/cockpit ps --config cockpit.toml --json` for which services of this
   checkout's stack run; `./node_modules/.bin/cockpit stacks --config cockpit.toml --json` for every
   stack on the machine. Run two only when the question spans them.
   A question about one diagnostic code, or a refusal the person pasted, may need no command: read
   what `./node_modules/@b00dea/cockpit/docs/troubleshooting.md` says about the code, and for a guard
   refusal, `./node_modules/@b00dea/cockpit/docs/safety-and-autonomy.md`. Done when you have the
   output, or the page, the answer rests on.
2. **Answer from that output.** Name each relevant diagnostic code, what it means, and the fix it
   names; say which wired repositories, agent tools and gates are involved, and what is still a
   gap. Quote the output for every claim instead of describing the configuration from memory.
   Done when every claim in your answer points at a line of output or a page.
3. **Give the next command** that changes the state, and who runs it: the agent, or a person in a
   terminal when the guard or a gate gives the step to a person. Done when the person can act on it
   without asking you again.

When explaining drift, say what each command does: `check` repairs nothing; `sync` rewrites a
hand-edited generated artifact such as `compose.cockpit.yml`, and refuses a hand-edited skill,
agent settings file or cockpit-owned region with `SURFACE_STATE_CONFLICT`; the fix for each case is
in *On drift* of the cockpit-setup skill's procedure, `../../cockpit-setup/procedures/setup.md` from
this file. For a secret question, follow its *Secret handling* section and distinguish the tracked
schema, the encrypted or provider source, the redacted status, injection into a trusted child
process, and the same-user read confinement that is unavailable.
