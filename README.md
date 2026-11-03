# cockpit

<a href="https://github.com/b0dea/cockpit/actions/workflows/ci.yml?query=branch%3Amain+event%3Apush"><img alt="CI status" src="https://github.com/b0dea/cockpit/actions/workflows/ci.yml/badge.svg?branch=main&amp;event=push"></a>
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

**One policy file that every coding agent on your team actually obeys, and a check that fails when
it stops.**

You write the policy once in <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml`: protected branches, secret files, hosts agents must not reach. cockpit
generates the matching instructions, skills, permissions and guard hook for Claude Code, Codex CLI and
OpenCode, and `cockpit check` fails locally or in CI when any generated file stops matching. It also
boots your product's Compose stack for agents and has them graded by something other than themselves.
It holds none of your product code.

## See it

The generated guard, given the same `git push origin main` that each tool sends before it runs a shell
command (`examples/minimal`, after `cockpit sync`):

```console
$ echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push origin main"}}' \
    | bash .cockpit/guards/bash-guard.sh --harness claudecode
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Refusing push to a declared protected branch."}}

$ ... --harness codexcli
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Refusing push to a declared protected branch."}}

$ ... --harness opencode
cockpit guard: Refusing push to a declared protected branch.
```

One policy, one evaluator, three transports: Claude Code and Codex read the JSON decision, OpenCode's
plugin turns the exit status and message into a thrown error. Codex runs the hook only after a person
trusts it once per machine; `cockpit doctor` warns until then. What was measured in each real tool, with
dates, is in the [capability matrix](docs/capability-matrix.md).

Diagnostics name what failed, why it matters and the fix, so a person or an agent can act on them
without reading the source.

## How cockpit compares

| Tool | What it owns | Where cockpit differs |
|---|---|---|
| [rulesync](https://github.com/dyoshikawa/rulesync), Ruler | One set of rules rendered for many agent tools | cockpit uses rulesync to spell the files for each tool, and adds the guard hook, permissions, a drift check for all of it, and a measured record of what each tool enforces. |
| Docker Compose, Tilt, Dev Containers | Running the services | cockpit runs your own `compose.yml` against the checkouts agents are editing, with port leases so parallel agents do not collide. It does not replace them. |
| OpenSpec, spec-kit | The plan: specs, tasks, prompts | cockpit owns the environment and the grading. They combine. |

## Quickstart

You need Node.js, Git, and macOS or Linux. No Docker is needed for the first steps.

**With an agent.** Open your coding agent in the repository and say: *set up cockpit for this project
using the guide in `docs/getting-started.md`* (the
[hosted copy](https://github.com/b0dea/cockpit/blob/main/docs/getting-started.md) works before the
install). The guide tells the agent what to ask you and what never to invent.

**By hand.** In the repository you want to protect:

```sh
npm i -D -E @b00dea/cockpit
npx cockpit init
```

`init` previews what it would write, installs the `cockpit-setup` skill for each agent tool in
`[surfaces] tools` (Claude Code, Codex CLI and OpenCode by default), and the interview that follows
fills in `cockpit.toml` from the files it finds, marking every value it guessed. Then:

```sh
npx --no cockpit sync     # write the generated files
npx --no cockpit check    # fail on drift; run it in CI too
```

[Getting started](docs/getting-started.md) walks through each step. Several repositories and a
Compose stack are the second chapter of that page, and the [tutorial](docs/tutorial.md) runs a
complete example.

## What you get

- **A guard.** Denies pushes to protected branches, reads and edits of declared env files and
  `.secrets`, and commands that reach declared hosted databases or vendor hosts; fails closed on input
  it cannot parse. See [Safety and autonomy](docs/safety-and-autonomy.md).
- **The same setup in every tool.** Instructions, skills, subagents, hooks, permissions and MCP servers
  from one config. `[surfaces] tools` picks the tools; `cockpit tool add` and `tool remove` change them.
  Sibling repositories' guides are copied in, so an agent started in any of them sees the same rules.
- **Drift checks.** `cockpit check` locally, in CI with the
  [`cockpit-check` action](docs/harness-surfaces.md), and at session start for tools that can run it.
- **A stack for agents.** `cockpit session -- claude` brings up your Compose stack on the live checkouts,
  holds it while the agent runs and releases it after. Port leases and holders mean one agent cannot
  stop another's stack. `seed` and `resettable_volumes` fill and wipe its data; `reset` needs a person
  by default.
- **Secrets stay out.** Varlock `.env.schema` files are validated without reading values; MCP servers
  need a pinned approval before `sync` enables them.
- **Work graded by someone else.** A work order (`workorders/<id>.md`, YAML front-matter) lists
  acceptance criteria with checks. Grading is `independent` (an evaluator in any listed tool reruns the
  checks and judges the change), `checks` (cockpit's own reruns decide) or `self`. A change that needs no
  order can use `cockpit grade --criteria <file>`. See [Work and browser](docs/work-and-browser.md).
- **A policy for who decides.** `[autonomy]` and `[work.gates]` say which steps an `agent`, a `person` or
  `ci` may pass. Everything defaults to `agent` except `reset`, which wipes data and needs a person;
  `check` and `doctor` report any weakening of the policy nobody has confirmed.
- **Browser checks.** `browser drive` and `browser screenshot` visit the application's declared routes
  with a local browser; a loopback browser service from your own Compose file can also publish the
  Playwright MCP and the `cockpit-browser` skill.
- **Upgrades in one command.** `cockpit upgrade [<version>] [--dry-run]` moves the exact pin and re-runs
  `sync`. Every command is in the [CLI reference](docs/cli-reference.md).

## Status and limits

Pre-1.0, macOS and Linux. Claude Code, Codex CLI and OpenCode are measured; the
[capability matrix](docs/capability-matrix.md) says what, when and in which version. Commands and
configuration can still change between minors ([release policy](docs/release-policy.md)). cockpit is not
a sandbox: guards and ignore rules stop mistakes, not malicious code running as your user. It is
maintained by one person; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

| If you want to | Read |
|---|---|
| Set it up for your own product | [Getting started](docs/getting-started.md) |
| Try it end to end | [Tutorial](docs/tutorial.md) |
| Look up a term | [Concepts](docs/concepts.md) |
| Look up a command or a config field | [Configuration essentials](docs/configuration-essentials.md), [CLI reference](docs/cli-reference.md), [Configuration reference](docs/configuration-reference.md) |
| Fix a diagnostic | [Troubleshooting](docs/troubleshooting.md) |
| See every page | [Documentation index](docs/README.md) |

## Contributing

Contributions from people and from AI coding agents are welcome. Agents start with
[AGENTS.md](AGENTS.md); people with [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues
privately as described in [SECURITY.md](SECURITY.md). Everyone follows the
[Code of Conduct](CODE_OF_CONDUCT.md). Changes are in the [changelog](packages/cockpit/CHANGELOG.md).

## License

[MIT](LICENSE).
