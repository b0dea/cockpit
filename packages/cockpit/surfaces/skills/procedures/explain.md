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
  follows a reinstall of cockpit or Node, or an edit to `cockpit.toml` the guard cannot build a policy
  from, and clears only when a person acts on its fix in a terminal. Any other edit to `cockpit.toml`
  holds nothing. One that does not widen what agents may do is judged as written, so run
  `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml` yourself; one that widens
  is judged under the configuration last synced, and each refusal says so, until a person approves
  it: they run `npx --no cockpit approve` in a terminal outside the agent and answer its one yes.
  Never answer it for them. When the guard refuses a
  command, read the reason. To read a file, use your tool's own file reading instead of the shell. A
  refusal for secrets, writes outside the cockpit, protected branches, declared hosts or the guard
  itself is the person's: hand them the exact command and why. A command refused as an unknown
  program or inline code is the person's too, or a reason to propose a `[[guards.allow]]` rule for
  that program. Do not reword, wrap or re-spell a command to get past the guard. If a harmless
  command of a known development tool is refused, report it as a cockpit gap (the command, the reason
  text, why it is harmless) and continue with other work rather than asking the person to run it.
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
   refusal, *Guard refusals* below, then `./node_modules/@b00dea/cockpit/docs/safety-and-autonomy.md`. Done when you have the
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

## Guard refusals

Match the start of the pasted reason to a row, and answer with its rule and the spelling that runs.
A reason that starts `Refusing` is a hard denial: no spelling passes it, so the next step is a
different action or the person's. Any other reason asks because the guard cannot read the form; the
spelling in its row says the same thing in a form the guard reads. Codex and OpenCode refuse what
asks. `<dir>`, `<VAR>` and `<path>` stand for the words the reason quotes.

| The reason starts | Rule | What runs instead |
| --- | --- | --- |
| `Refusing to read or write an environment file`, `Refusing <program>: it holds <word>, which names or can match an environment file, secrets directory, declared instance or credential store`, `Refusing to read, write, search or stage a path [guards] secret_paths declares` | Secrets, wherever the name sits: an argument, a redirect, a glob, inline code or a heredoc | Run the process through a declared project command or script that wraps Varlock; list names with `./node_modules/@b00dea/cockpit/bin/cockpit.mjs env keys --config cockpit.toml`; name the files the command needs |
| `Refusing to read, print or send a credential store`, `Refusing to print the environment or a variable named as a secret` | Credential stores, agent tool logins and environment dumps; a credential name is judged from home wherever it sits, after an expansion (`"$X/.netrc"`) and in inline code that finds home by any lookup | A person handles the store; print a non-secret variable by name, or list names with `env keys` |
| `Refusing mutation of the guard, its hook registration or its ownership manifest`, `Refusing to write an agent tool's settings, hooks or MCP configuration`, `Refusing to change the installed cockpit, a node_modules/.bin directory or a command search path directory`, `Refusing code the guard does not read, such as a command held in a variable or inline script, that names the installed cockpit` | The guard itself and the code it runs | A person changes guard files; refresh dependencies with the package manager's clean install; run cockpit as a plain `npx --no cockpit <command>` and read its files with `cat` |
| `Refusing a force push`, `Refusing push to a declared protected branch`, `Refusing a forced push, a remote branch deletion or a push that names a protected branch` | Branches and history; inline code and heredocs are read as one list of words | Push new commits to a work branch, and a person or CI merges; write prose that mentions a push with the editor's write tool |
| ``cd is judged only as `cd <dir> && <command>` `` | `cd` alone in its command, with one literal directory: absolute, starting `./` or `../`, or a name that starts with no dot in a call that leaves `CDPATH` alone (under Claude Code with an empty `CDPATH`, any relative name that exists below); not after `!`, in a loop, an `if`, a pipeline or the background, and no `..` after a name | `cd <dir> && <command>` for a directory that exists; `cd ./.<dir>` for a dot-leading one; `git -C <dir>` for Git |
| `Refusing cd <dir>: a shell with CDPATH set can resolve the name from the home directory`, `Refusing <word> after cd <dir>: a shell with CDPATH set can resolve that name`, `cd <dir> names nothing below the directory it runs from` | A bare name may resolve through `CDPATH`, from home | `cd ./<dir>`, once the directory exists |
| `After cd <dir>, a shell with CDPATH set may stand outside the cockpit` | After a bare-name `cd`: a `$` or backtick outside single quotes, a value holding `..`, a pattern that can expand to `..`, a program that reads paths from a file or standard input, or a name that is part of the home directory's own path | `cd ./<dir>`, or name the path from the cockpit |
| `Dynamic heredoc expansion is unsupported` | An unquoted delimiter expands the body | `<<'EOF'`; for a commit message, `git commit -F - <<'EOF'` |
| `Missing or dynamic redirect target` | Only a literal path, or a `NAME=path` the call assigns first | Write the path out, or `NAME=path` on its own before `> "$NAME"` |
| `Arithmetic expansion $((…)) is read only over numbers and operators` | bash evaluates a name's value as code | Compute the number and write it out |
| `<command> runs with <VAR> set to <value>, a program Git runs`, `<command> sets <VAR>, a variable naming a program Git runs or a file it writes`, ``Refusing `git -c <key>` `` | Git program variables (`GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_EDITOR` and the rest), set, exported or handed to a builtin, and program keys; a pager variable runs | Run it without that variable or key; a variable set elsewhere goes as a prefix of the git command itself, where it is judged |
| `<command> sets <VAR>, which changes where Git looks for its repository and configuration` | `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG*`, `HOME`, `BASH_ENV` and the like | Run it without that assignment; use `git -C <dir>` |
| `<command> writes to <path>, a path holding a glob`, `<command> writes to <path>, a path holding an expansion the call sets` | Write targets the shell expands | Write the path out, or assign it as the call's first command: `NAME=path; <command> "$NAME"` |

A reason no row matches: quote it and read the section of `safety-and-autonomy.md` it names.
