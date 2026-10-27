# cockpit

<!-- cockpit:verified version=0.0.0 -->

![CI status](https://github.com/b0dea/cockpit/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

**One config for a multi-repo product: the whole stack on your laptop, the same rules in every
agent tool, and grading by something other than the agent that did the work.**

cockpit runs the environment your AI coding agents work in. You declare your product's
repositories once in <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml`; cockpit starts the whole stack against your live local
checkouts, gives Claude Code, Codex CLI and OpenCode the same instructions, skills, guards and
permissions, and hands finished work to an independent evaluator. It holds none of your product
code.

> **Status: pre-alpha, version 0.0.0, install from source.** Commands, configuration and the
> generated file layout will change in backward-incompatible ways before 1.0.
> See [Status and limits](#status-and-limits).

## Why cockpit

An agent editing one repository of a multi-repository product hits three problems that more
prompting does not fix:

1. **The environment drifts.** The agent sees one checkout. The services, sibling repositories,
   ports and seed data it needs to run the product live in someone's head or a stale script.
   cockpit declares them once and boots the product from the checkouts you are editing.
2. **Agent configuration drifts.** Claude Code, Codex CLI and OpenCode each want their
   instructions, skills, hooks and permissions in a different file and spelling. cockpit renders
   all of them from one declaration and fails `cockpit check` when any generated file changes.
3. **Agents grade their own work.** "Done" is usually the author's own report. cockpit's work
   orders end with a separate evaluator that reruns the declared checks and grades each
   acceptance criterion from that evidence, not from the author's summary.

## How it works

```mermaid
flowchart LR
    toml["cockpit.toml<br/>repositories, services,<br/>guards, harnesses"] --> sync["cockpit sync"]
    sync --> compose["Docker Compose stack<br/>on your live checkouts"]
    sync --> surfaces["Agent surfaces<br/>Claude Code · Codex CLI · OpenCode"]
    compose --> session(("agent session"))
    surfaces --> session
    session --> grade["independent evaluator<br/>reruns checks, grades criteria"]
    check["cockpit check"] -. "fails on drift" .-> compose
    check -. "fails on drift" .-> surfaces
```

`sync` writes every generated file and records what it owns. `check` compares those files with
what the configuration would produce now and fails on any difference. `up` starts the stack,
`preflight` is the gate that says it is healthy, and `session` keeps the stack up for exactly as
long as one agent command runs.

## Quickstart

Requires Node.js `^22.13.0 || ^24.0.0 || ^26.0.0`, Git, and macOS or Linux. The synthetic
example needs no credentials and no Docker.

**1. Install from source** and put `cockpit` on your PATH:

```sh
git clone https://github.com/b0dea/cockpit.git && cd cockpit
npm ci --ignore-scripts && npm run build
npm link --workspace @b0dea/cockpit
```

**2. Copy the example** somewhere outside the checkout, then run the first command block of
[examples/synthetic/README.md](examples/synthetic/README.md) there. It creates two throwaway
Git repositories for cockpit to manage.

```sh
cp -R examples/synthetic "${TMPDIR:-/tmp}/cockpit-demo" && cd "${TMPDIR:-/tmp}/cockpit-demo"
```

**3. Preview what cockpit generates.** The dry run lists every file it would write for the
three agent tools and the stack, and writes none of them (output trimmed):

<!-- cockpit:capture date=2026-10-27 version=0.0.0 -->
```console
$ cockpit sync --config cockpit.toml --dry-run
write "AGENTS.md"
write "CLAUDE.md"
write "compose.generated.yml"
write "opencode.jsonc"
write ".agents/skills/bootstrap/SKILL.md"
...
write ".claude/agents/evaluator.md"
write ".claude/settings.json"
...
write ".cockpit/guards/bash-guard.sh"
write ".codex/agents/evaluator.toml"
write ".codex/config.toml"
...
write ".opencode/plugin/cockpit-guards.js"
...
write ".cockpit/generated-environment-ownership.json"
```

The [tutorial](docs/tutorial.md) continues from here: apply the sync, run `setup` and `check`,
break a generated file and watch `check` catch it, and read the configuration section by
section.

## Features

- **One registry for the whole product.** Repositories, services, images, volumes, ports, seed
  data and stubbed vendors live in one validated file.
- **Live checkouts, not copies.** The stack mounts the working trees your agent is editing.
- **Same agent environment in every harness.** Rules, skills, subagents, hooks, MCP servers and
  permissions are rendered for Claude Code, Codex CLI and OpenCode from one source.
- **Drift is a failing check.** Generated files are committed, owned and compared byte for byte;
  `cockpit check` runs locally and in CI.
- **Preview before every write.** `sync --dry-run` and `reset` show the exact changes; deleting
  anything stale or resetting data needs an interactive confirmation of that exact preview.
- **Guards that run before the tool does.** One guard policy denies pushes to protected
  branches, edits to environment and secret files, and commands that reach declared hosted
  databases or vendor hosts, translated into each harness's hook format.
- **Work orders with independent grading.** Acceptance criteria, declared verification commands,
  and an evaluator that is never the session that did the work.
- **Shared machines stay safe.** Port leases, holder tracking and `sleep` mean one agent cannot
  stop another agent's stack.
- **Adopt what you already have.** `cockpit document` turns an existing shell-registry cockpit
  into an annotated draft, marking every value it inferred and every gap it could not fill.

## How cockpit compares

| Tool | What it owns | Where cockpit differs |
|---|---|---|
| Spec and workflow tools (OpenSpec, spec-kit) | The plan: specs, tasks and prompts for the work | cockpit owns the environment the work runs in. They combine. |
| Dev Containers, Devbox | A reproducible development container or toolchain | cockpit boots a product made of several repositories and configures the agents too. |
| Tilt, Garden | Dev loops for service stacks, centred on Kubernetes | cockpit targets Docker Compose on one machine and adds agent surfaces and grading. |
| Plain Docker Compose | Running the services | cockpit generates the Compose file and adds agent configuration, drift checks and grading. |

## Supported agent tools

| Harness | Target name | Where cockpit writes its surfaces |
|---|---|---|
| Claude Code | `claudecode` | CLAUDE.md and .claude/ (skills, evaluator subagent, guard hook, permissions) |
| Codex CLI | `codexcli` | AGENTS.md, .agents/skills/ and .codex/ (evaluator agent, guard hook, rules) |
| OpenCode | `opencode` | opencode.jsonc and .opencode/ (skills, evaluator agent, guard plugin) |

Each generated feature has a measured state: *enforced*, *instructed* or *unavailable*. Today
every built-in cell is *instructed*; see [Status and limits](#status-and-limits) and the
[capability matrix](docs/capability-matrix.md).

## Status and limits

cockpit is pre-alpha. It is developed against real multi-repository products, and the public
repository carries only synthetic fixtures. What is true today:

- **Source install only.** The package is private at 0.0.0 and is not on npm. Install with the
  [Quickstart](#quickstart) commands.
- **Breaking changes before 1.0.** Commands, configuration fields and the generated file layout
  can change between minors. [Release policy](docs/release-policy.md) covers deprecation and
  migration notes.
- **macOS and Linux.** CI runs both on Node 22.13, 24 and 26. Windows is not supported.
- **Bringing the stack up currently needs Docker Desktop.** `up`, `session`, `preflight`, `down`
  and `reset` need Docker with Compose, and the runtime check today admits only Docker Desktop.
  OrbStack, Colima, Rancher Desktop and Linux Docker Engine are refused, currently with a
  generic `LIFECYCLE_EVIDENCE_INVALID`. Wider runtime support is being designed. Generation,
  `setup` and `check` work without Docker.
- **Native enforcement is not yet measured.** cockpit generates the hooks, permissions and rules,
  and its guard adapters were probed against specific harness versions (Claude Code 2.1.220,
  Codex 0.149.0, OpenCode 1.18.15, August 2026). It has not re-measured them against current
  versions, so every built-in feature is reported as *instructed*, not *enforced*.
  [Harness surfaces](docs/harness-surfaces.md#capability-states) explains the states and how
  `cockpit selftest` measures them.
- **Not a sandbox.** Guards, Git ignore rules and file permissions stop mistakes, not malicious
  code running as your user. [Safety and autonomy](docs/safety-and-autonomy.md) lists what each
  guard does.
- **The synthetic example stops at `check`.** It declares services but ships no service code
  to run, so it demonstrates configuration, generation and drift, not a running stack.
- **One maintainer.** See [Governance](CONTRIBUTING.md#governance).

## Documentation

| If you want to | Read |
|---|---|
| Try cockpit end to end on the example | [Tutorial](docs/tutorial.md) |
| Set cockpit up for your own product | [Getting started](docs/getting-started.md) |
| Move an existing setup over gradually | [Incremental adoption](docs/adoption.md) |
| Look up a term | [Concepts](docs/concepts.md) |
| Look up a command or flag | [CLI reference](docs/cli-reference.md) |
| Look up a configuration field | [Configuration reference](docs/configuration-reference.md) |
| Fix a diagnostic | [Troubleshooting](docs/troubleshooting.md) |
| Extend overlays, guards or harnesses | [Harness surfaces](docs/harness-surfaces.md#ownership-and-extension) and [Architecture](docs/architecture.md) |
| Get a quick answer | [FAQ](docs/faq.md) |

The [documentation index](docs/README.md) lists every page.

## Contributing

Contributions are welcome from people and from AI coding agents.

- **AI agents:** start with [AGENTS.md](AGENTS.md). It is the working guide for this codebase.
- **People:** read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the
  [verification gates](CONTRIBUTING.md#verification), and what will not be accepted.
- **Questions and bugs:** open an issue using one of the forms. Review routing is in
  [CODEOWNERS](.github/CODEOWNERS).
- **Security:** never in a public issue. See [SECURITY.md](SECURITY.md).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Changes are recorded in
the [changelog](CHANGELOG.md).

## License

[MIT](LICENSE).
