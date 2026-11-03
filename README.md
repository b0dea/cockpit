# cockpit

<a href="https://github.com/b0dea/cockpit/actions/workflows/ci.yml?query=branch%3Amain+event%3Apush"><img alt="CI status" src="https://github.com/b0dea/cockpit/actions/workflows/ci.yml/badge.svg?branch=main&amp;event=push"></a>
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

**One policy file that every coding agent on your team actually obeys, and a check that fails when
it stops.**

cockpit turns one <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` into the instructions, skills, permissions and guard hook that
Claude Code, Codex CLI and OpenCode each expect, and checks that they still match.

- **Write it once.** Instructions, skills, hooks, permissions and MCP servers for every tool on the
  team, from one file you review like code.
- **Refusals that hold.** One guard denies pushes to protected branches, reads of secrets and
  commands against the production hosts you declare, in all three tools, and sends anything it cannot
  prove read-only to a person.
- **Drift fails a check.** `cockpit check` goes red locally, at session start and in CI when a
  generated file stops matching the policy.
- **Room for parallel agents.** Optional: bring your Compose stack up per agent with leased ports, and
  have finished work graded by a separate read-only run instead of the agent that wrote it.

## See it

After `cockpit init` in a fresh repository, the generated guard gets the same `git push origin main`
that each tool sends before it runs a shell command:

```console
$ echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push origin main"}}' \
    | bash .cockpit/guards/bash-guard.sh --harness claudecode
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Refusing push to a declared protected branch."}}

$ ... --harness codexcli
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Refusing push to a declared protected branch."}}

$ ... --harness opencode        # stderr, exit status 2
> cockpit guard: Refusing push to a declared protected branch.
```

One policy, one guard, three transports: Claude Code and Codex read the JSON decision, and OpenCode's
plugin turns the exit status into a thrown error. Each refusal was also measured in the real tool beside
a control without the hook; the [capability matrix](docs/capability-matrix.md) has the dates and
versions. Codex runs the hook only after a person trusts it once per machine, and `cockpit doctor` warns
until then.

## Why cockpit

You run more than one coding agent, or one agent on a product with secrets, protected branches and
production hosts. Then:

| Without cockpit | With cockpit |
|---|---|
| Each tool reads its own files (`CLAUDE.md`, `.claude/settings.json`, `.codex/hooks.json`, an OpenCode plugin), copied by hand and drifting apart. | One `cockpit.toml` generates them all; `check` names the file that drifted. |
| "Never push to main" and "never touch production" are sentences the agent may skip. | A guard hook every tool runs before the call refuses it, whatever the prompt said. |
| Two agents in two worktrees start the same stack on the same ports and stop each other's containers. | Each checkout leases its own port family, and a stack stays up while any holder needs it. |
| The agent that wrote the change decides it is done. | A separate run, read-only and without the writer's session, reruns the checks and grades each criterion. |

cockpit holds none of your product code; it owns the environment the agents work in.

## How cockpit compares

| Tool | What it owns | Where cockpit differs |
|---|---|---|
| Hand-written `AGENTS.md` and per-tool settings | Instructions | cockpit writes those files too, adds the enforcement an instruction cannot give, and tells you when a copy drifts. |
| [rulesync](https://github.com/dyoshikawa/rulesync), [Ruler](https://github.com/intellectronica/ruler) | One set of rules rendered for many agent tools | cockpit uses rulesync to spell each tool's files, and adds the guard hook, permissions, a drift check for all of it, and a dated record of what each tool enforces. |
| Docker Compose, Tilt, Dev Containers | Running the services | cockpit runs your own `compose.yml` against the checkouts agents edit, with port leases so parallel agents do not collide. It does not replace them. |
| OpenSpec, spec-kit | The plan: specs, tasks, prompts | cockpit owns the environment and the grading. They combine. |

## Quickstart

You need Node.js, Git, and macOS or Linux. No Docker for the first steps.

**With an agent.** Open your coding agent in the repository and say: *set up cockpit for this project
using the guide in `docs/getting-started.md`* (the
[hosted copy](https://github.com/b0dea/cockpit/blob/main/docs/getting-started.md) works before the
install). The guide tells the agent what to ask you and what never to invent.

**By hand.** In the repository you want to protect:

```sh
npm i -D -E @b00dea/cockpit
npx --no cockpit init
```

The first `init` writes nothing. It previews where the cockpit goes and the files it would install:

```console
$ npx --no cockpit init
cockpitRoot:
  ...
  recommended: in-repo
  ...
files:
  -
    path: .claude/skills/cockpit-setup/SKILL.md
    sha256: 65cb0ae088e3944a8c21203b1d32d9844b9e4f3614c9de23414770fe422e871f
  ...
previewSha256: 463bc798d37a5089a53231526f90ce659366498c622657bce05442d7c2196c5d
...
stage: surface-previewed
target: claudecode
```

Accept the preview and answer the interview, then commit what it wrote:

```sh
npx --no cockpit init --interactive            # type the preview digest, answer each question
npx --no cockpit sync --config cockpit.toml    # rerun after every edit of cockpit.toml
npx --no cockpit check --config cockpit.toml   # fail on drift; run it in CI too
```

The interview proposes values from files it can read (a `package.json` script, a Dockerfile `EXPOSE`,
variable names in `.env.example`) and marks each with where it came from. You confirm every one. Then
an agent started in the repository loads the same instructions and skills in each tool, and the guard
is live (in Codex once a person trusts it). [Getting started](docs/getting-started.md) walks through
each step; several repositories and a Compose stack are its second chapter.

## What you get

### One config, every tool

`[surfaces] tools` picks the tools; `npx --no cockpit tool add opencode --config cockpit.toml` adds one
and `tool remove` drops it. The guides of sibling repositories are copied into the root instructions,
so an agent started in the cockpit sees every repository's rules. See [Harness surfaces](docs/harness-surfaces.md).

### A guard that fails closed

Built-in denials cover pushes to `guards.protected_branches` (`main` and `master` by default), reads of
anything under `.secrets` or a declared environment instance, and commands that reach a declared hosted
database or vendor host. A command the guard cannot prove read-only goes to a person, and input it
cannot parse is refused. `[[guards.allow]]` admits your own commands for good. See
[Safety and autonomy](docs/safety-and-autonomy.md).

### Drift checks and diagnostics that name the fix

`check` runs locally, in CI with the [`cockpit-check` action](docs/harness-surfaces.md), and at session
start in Claude Code and Codex. Every diagnostic says what failed, why it matters and what to do:

```console
$ npx --no cockpit check --config cockpit.toml
ERROR SURFACE_STATE_CONFLICT [.claude/settings.json]
What failed: this generated file was edited by hand since cockpit last wrote it, and sync does not overwrite hand edits
Why it matters: sync would overwrite content that cockpit did not write
Fix: keep the edit by moving it into cockpit.toml or a surface overlay, ...
```

### A stack per agent

`npx --no cockpit session --config cockpit.toml -- claude` brings your Compose stack up on the live
checkouts, holds it while the agent runs and releases it after. Each checkout leases a port family, so
worktrees and parallel agents do not collide, and one agent cannot stop another's stack. A `seed`
command fills the data and `resettable_volumes` says what `reset` may wipe. See
[Environment lifecycle](docs/environment.md).

### Work graded by someone else

A work order lists acceptance criteria, each with a check. `work grade` reruns the checks, then an
evaluator from `work.evaluators` grades each criterion in a fresh read-only run that starts outside the
repository and never sees the writer's session. For a change without an order:
`npx --no cockpit grade --config cockpit.toml --criteria criteria.md`. Grading can also be `checks`
(cockpit's reruns decide) or `self`. See [Work and browser](docs/work-and-browser.md).

### Gates for who decides

`[autonomy]` and `[work.gates]` say which steps an `agent`, a `person` or `ci` may pass. Everything
defaults to `agent` except `reset`, which wipes data, and `mcp_approve`, because an enabled MCP server
runs outside the guard. The guard denies an agent's edit of those tables, and `check` reports any
weakening nobody has confirmed.

### Also

- **Secrets stay out.** Varlock `.env.schema` files are validated without reading values; MCP servers
  need a recorded approval before `sync` enables them.
- **Browser checks.** `browser drive` and `browser screenshot` visit the application's declared routes.
- **Upgrades in one command.** `npx --no cockpit upgrade --config cockpit.toml` moves the exact pin
  and reruns `sync`.

## Status and limits

Pre-1.0, macOS and Linux; commands and configuration can still change between minors
([release policy](docs/release-policy.md)). The [capability matrix](docs/capability-matrix.md) says
what each tool enforces, measured on which date and version. cockpit is not a sandbox: the guard stops
mistakes, not malicious code running as your user.

## Documentation

| If you want to | Read |
|---|---|
| Set it up for your own product | [Getting started](docs/getting-started.md) |
| Try it end to end | [Tutorial](docs/tutorial.md) |
| Join a teammate's cockpit | [Joining a team's cockpit](docs/joining-a-team.md) |
| Look up a term | [Concepts](docs/concepts.md) |
| Look up a command or a config field | [CLI reference](docs/cli-reference.md), [Configuration essentials](docs/configuration-essentials.md) |
| Fix a diagnostic | [Troubleshooting](docs/troubleshooting.md) |
| See every page | [Documentation index](docs/README.md) |

## Contributing

Contributions from people and from AI coding agents are welcome. Agents start with
[AGENTS.md](AGENTS.md); people with [CONTRIBUTING.md](CONTRIBUTING.md), which also says how the
project is maintained. Report security issues privately as described in [SECURITY.md](SECURITY.md).
Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md). Changes are in the
[changelog](packages/cockpit/CHANGELOG.md).

## License

[MIT](LICENSE).
