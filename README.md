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

Sync, guard and check are the product, and you can adopt just that. A stack per agent and independent
grading are [optional](#when-you-need-more) and off until you configure them.

## A cockpit.toml

`cockpit init` writes this (trimmed here to the meaningful lines) for a repository whose guard should
refuse pushes to `main` and anything that reaches a production database host:

```toml
[cockpit]
name = "my-app"
siblings_root = "."

[[sibling]]                      # the repository the agents work in
slug = "my-app"
dir = "."
mount = "always"
acquire = "none"
var = "MY_APP_DIR"
toolchain = "none"
guides = [ "CLAUDE.md", "AGENTS.md" ]   # copied into the generated root instructions
purpose = "The product"

[ports.bases]                    # no stack yet, so no ports

[guards]
hosted_db_hosts = [ "db.prod.example.com" ]
protected_branches = [ "main", "master" ]

[surfaces]
tools = [ "claudecode", "codexcli" ]
```

`sync` renders it into these files, and `check` fails when they stop matching (`tool add|remove`
changes the tool list; see [Harness surfaces](docs/harness-surfaces.md)):

```text
AGENTS.md  CLAUDE.md                 root instructions, one per tool family
.claude/settings.json                Claude Code hook, permissions and deny rules
.claude/skills/  .agents/skills/     cockpit's own skills for Claude Code and Codex
.codex/config.toml  .codex/hooks.json  Codex sandbox and guard hook
.opencode/plugin/  opencode.jsonc    OpenCode guard plugin and permissions (when listed)
.cockpit/guards/bash-guard.sh        the one guard all three tools call
.cockpit/policy.json                 the policy `sync` last ran under
```

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
versions.

**What the guard sees.** Shell commands in all three tools. In Claude Code also its Edit and Write
tools, through the same hook, and its Read tool, through generated deny rules (a deny beats an allow, so
Claude's Read refuses `.env.example` too; `cat .env.example` works). In OpenCode the plugin restates its
native read, grep and glob as the shell command that reads the same paths.

**What it does with a command it cannot prove read-only.** It asks a person. `ls`, `git status` and
`cat src/x.ts` pass; `node --test` and `curl https://example.com` go to a person. `[guards] allow`
rules (and a declared build or test command run from its checkout) widen that. Input it cannot parse is
refused.

## How cockpit compares

cockpit holds none of your product code; it owns the environment the agents work in.

| Tool | What it owns | Where cockpit differs |
|---|---|---|
| Hand-written `AGENTS.md` and per-tool settings | Instructions | cockpit writes those files too, adds the enforcement an instruction cannot give, and tells you when a copy drifts. |
| [rulesync](https://github.com/dyoshikawa/rulesync), [Ruler](https://github.com/intellectronica/ruler) | One set of rules rendered for many agent tools | cockpit depends on rulesync and uses it to render each tool's files, and adds the guard hook, permissions, a drift check for all of it, and a dated record of what each tool enforces. |
| Docker Compose, Tilt, Dev Containers | Running the services | cockpit runs your own `compose.yml` against the checkouts agents edit, with port leases so parallel agents do not collide. It does not replace them. |
| OpenSpec, spec-kit | The plan: specs, tasks, prompts | cockpit owns the environment and the grading. They combine. |

## Quickstart

**Requirements and caveats**

- macOS or Linux, Git, and Node.js as listed in `engines` in
  [package.json](packages/cockpit/package.json). Docker only for the optional stack commands.
- Pre-1.0: commands and configuration can change between minors ([release policy](docs/release-policy.md)).
- Codex runs the guard hook only after a person trusts it once per machine; `cockpit doctor` warns until then.
- Enabling an MCP server and `reset` (it wipes data) need a person by default.

**With an agent.** Open your coding agent in the repository and say: *set up cockpit for this project
using the guide in `docs/getting-started.md`* (the
[hosted copy](https://github.com/b0dea/cockpit/blob/main/docs/getting-started.md) works before the
install). The guide tells the agent what to ask you and what never to invent.

**By hand.** In the repository you want to protect:

```sh
npm i -D -E @b00dea/cockpit
```

```sh
npx --no cockpit init                          # previews what it would write; writes nothing yet
npx --no cockpit init --interactive            # type the preview digest, answer each question
npx --no cockpit sync --config cockpit.toml    # rerun after every edit of cockpit.toml
npx --no cockpit check --config cockpit.toml   # fail on drift; run it in CI too
```

The interview proposes values from files it can read (a `package.json` script, a Dockerfile `EXPOSE`,
variable names in `.env.example`) and marks each with where it came from. You confirm every one. Commit
what it wrote; an agent started in the repository then loads the same instructions and skills in each
tool, and the guard is live (in Codex once a person trusts it). [Getting started](docs/getting-started.md)
walks through each step; several repositories and a Compose stack are its second chapter.

## What you get

### A guard that fails closed

Built-in denials cover pushes to `guards.protected_branches` (`main` and `master` by default), reads of
anything under `.secrets` or a declared environment instance, reads and writes of `.env` and `.env.*`
files other than documentation names such as `.env.example` and declared templates, and commands that
reach a declared hosted database or vendor host. `[[guards.allow]]` admits your own commands for good.
See [Safety and autonomy](docs/safety-and-autonomy.md).

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

### Gates for who decides

`[autonomy]` and `[work.gates]` say which steps an `agent`, a `person` or `ci` may pass. Everything
defaults to `agent` except `reset` and `mcp_approve`. The guard denies an agent's edit of those tables,
and `check` reports any weakening nobody has confirmed.

### Also

- **Secrets stay out.** Varlock `.env.schema` files are validated without reading values.
- **Upgrades.** `npx --no cockpit upgrade --config cockpit.toml` moves the pin and reruns `sync`.

## When you need more

Nothing below is needed for sync, guard and check. `browser drive` and `browser screenshot` also
visit the application's declared routes.

### A stack per agent

Optional, and the only part that needs Docker Compose.
`npx --no cockpit session --config cockpit.toml -- claude` brings your Compose stack up on the live
checkouts, holds it while the agent runs and releases it after. Each checkout leases a port family, so
parallel agents do not collide. A `seed` command fills the data and `resettable_volumes` says what
`reset` may wipe. See [Environment lifecycle](docs/environment.md).

### Work graded by someone else

Optional. Grading needs one agent tool on `PATH` and signed in; with a second one, grading is
cross-tool by default. A work order lists acceptance criteria, each with a check. `work grade` reruns
the checks, then an evaluator from `work.evaluators` grades each criterion in a fresh read-only run that starts outside the
repository and never sees the writer's session. For a change without an order:
`npx --no cockpit grade --config cockpit.toml --criteria criteria.md`. Grading can also be `checks`
(cockpit's reruns decide) or `self`. From inside Claude Code the other listed tool grades first, and
`--evaluator <tool>` picks one grader for a run. See [Work and browser](docs/work-and-browser.md).

## Status and limits

The [capability matrix](docs/capability-matrix.md) says what each tool enforces, measured on which date
and version. cockpit is not a sandbox: the guard stops mistakes, not malicious code running as your user.

## Documentation

| If you want to | Read |
|---|---|
| Set it up for your own product | [Getting started](docs/getting-started.md) |
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
