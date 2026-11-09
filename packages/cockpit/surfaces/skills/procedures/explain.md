---
loading: pull
budget: uncapped
---

<!-- cockpit:verified version=0.0.0 -->

# Explain a cockpit

## Running cockpit

- Run every command from the cockpit root, the directory holding `cockpit.toml`, through the
  installed package entrypoint, for example `./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml`.
  This path resolves to the installed package even when pnpm writes a shell shim in `node_modules/.bin`.
  `npx --no cockpit <command>` and the `.bin` launcher count only where the guard can prove they
  start that same package. If the entrypoint is missing, stop and ask the person to install cockpit;
  a runner that downloads a package is never a substitute.
- Take flags from each command's `--help`. With `--json`, read `result`, `diagnostics[].code`,
  `guidance[]` and `invocation.exitCode`. A diagnostic's remedy is the `guidance` entry with its
  `code` and `target`; `diagnostics[].fix` appears only for a command safe to run as printed, and
  `./node_modules/@b00dea/cockpit/docs/troubleshooting.md` covers the codes that need more; the
  other user-guide pages cited here sit beside it.
- When the guard asks before a command, the person decides in Claude Code; Codex and OpenCode deny
  instead, so hand the person the exact command to run in a terminal. A refusal that holds every
  guarded tool call (a guard message saying so, `GUARD_AUTHORITY_UNAVAILABLE` or `GUARD_CONFIG_UNSYNCED`)
  follows any edit to `cockpit.toml` or reinstall of cockpit or Node. `GUARD_CONFIG_UNSYNCED` means
  the edit does not widen what agents may do, so run
  `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml` yourself where `[autonomy] sync =
  "agent"`; any other hold clears only when a person runs it in a terminal. When the guard refuses a
  command, read the reason. To read a file, use your tool's own file reading instead of the shell. A
  refusal for secrets, writes outside the cockpit, protected branches, declared hosts or the guard
  itself is the person's: hand them the exact command and why. Do not reword, wrap or re-spell a
  command to get past the guard. If the refused command could not touch any of those, report it as a
  cockpit gap (the command, the reason text, why it is harmless) and continue with other work rather
  than asking the person to run it.
- In Codex's sandbox `check`, `sync --dry-run` and `--help` work as it stands, unless `[browser]` is
  declared, which makes the first two read cockpit's state too. Other cockpit commands need what the
  sandbox withholds: write access to the state root, which `STATE_ROOT_UNAVAILABLE` names and a person
  can grant on that directory alone, or on its nearest existing parent before it exists; the Docker
  socket; and on macOS `/bin/ps`. First inspect the named failure and request only the missing
  access through the native approval mechanism. Prepare the concrete command and reason before
  asking; preserve existing grants. Under `codex exec`, which cannot ask, hand that command to the
  person. A sandbox refusal does not establish product failure.
- Ask, never invent. A port, image, command, host, purpose, name, version, role or credential comes
  from a file you read or from the person; with neither, name the gap and ask.

## Explain

You answer a question about this cockpit from what its commands report now, and change nothing.

1. **Pick the command that answers the question**, and only that one:
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config cockpit.toml --json` for environment health, wiring
   and readiness gaps; `./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml --json` for generated
   files that drift from `cockpit.toml`; `./node_modules/@b00dea/cockpit/bin/cockpit.mjs preflight --config cockpit.toml --json`
   for whether the environment passes the gate work needs;
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs ps --config cockpit.toml --json` for which services of this
   checkout's stack run; `./node_modules/@b00dea/cockpit/bin/cockpit.mjs stacks --config cockpit.toml --json` for every
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
