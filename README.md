<!-- Logo: save it as docs/assets/cockpit-logo.png, then add
<p align="center"><img src="docs/assets/cockpit-logo.png" alt="" width="160"></p> above the title. -->

<h1 align="center">cockpit</h1>

<p align="center"><strong><em>Where coding agents work on your whole product.</em></strong></p>

<p align="center">
  <a href="https://github.com/b0dea/cockpit/actions/workflows/ci.yml?query=branch%3Amain+event%3Apush"><img alt="CI status" src="https://github.com/b0dea/cockpit/actions/workflows/ci.yml/badge.svg?branch=main&amp;event=push"></a>
  <a href="https://www.npmjs.com/package/@b00dea/cockpit"><img alt="npm version" src="https://img.shields.io/npm/v/@b00dea/cockpit?color=blue"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green.svg"></a>
  <a href="docs/README.md"><img alt="Documentation" src="https://img.shields.io/badge/docs-guide-blue.svg"></a>
</p>

<p align="center">
  <a href="#try-it">Try it</a> ·
  <a href="docs/getting-started.md">Getting started</a> ·
  <a href="docs/tutorial.md">Tutorial</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="docs/faq.md">FAQ</a>
</p>

cockpit is an open-source CLI that gives coding agents the environment a real product needs: every
repository in reach, the product running on the checkouts they edit, the same instructions, skills and
guard in Claude Code, Codex and OpenCode, and work checked against criteria you set. All of it comes
from one <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` you review like code.

## Choose your starting point

| What you need | Start here | What you get |
|---|---|---|
| Agents in one repository follow the same rules in every tool | [One repository, no Docker](docs/getting-started.md#chapter-1-one-repository-one-tool-no-docker) | The same instructions, skills and guard in each tool, and a CI check that fails on drift |
| Agents work across several repositories with the product running | [Several repositories and a stack](docs/getting-started.md#chapter-2-several-repositories-and-a-compose-stack) | Every repository in reach and your Compose stack per checkout, on its own ports |
| Changes held to criteria you set | [Work orders](#work-orders) | A scope, checks and a grade whose record names who judged it |
| Your agent to do the setup | [Set up with an agent](docs/getting-started.md#set-up-with-an-agent) | A setup that asks you for every value it cannot read and invents none |
| To join a team that already uses it | [Joining a team's cockpit](docs/joining-a-team.md) | A verified install from a fresh clone |
| To move an existing scripted setup over | [Adopt an existing setup](docs/getting-started.md#adopt-an-existing-setup) | Your registry and scripts adopted in layers, with your own agent settings kept |

Each is independent: start with one and add the others when you need them. Only the stack needs Docker.

## Why

Coding agents are good at a change inside one repository. A real product is several repositories, a
running stack and, more and more, more than one agent tool. That is where they come apart:

- The agent edits the frontend but cannot run the backend it calls, or read that repository's guide.
- Your `CLAUDE.md` never reaches Codex or OpenCode, and each tool's permissions are copied by hand
  until they disagree.
- Two agents working in parallel fight over the same ports and the same database.
- "Tests pass" is the agent's word, and the diff touched files nobody asked it to.

cockpit fixes the environment, not the agent. The configuration declares the repositories, the stack,
the guard and how work is checked; cockpit renders it into each tool's own files, runs the stack, and
fails CI when any generated file drifts from it. It holds none of your product code.

## Try it

In a repository you want to protect (macOS or Linux, Git, and Node.js as listed in `engines` in
[package.json](packages/cockpit/package.json); no Docker):

```sh
npm install --save-dev --save-exact @b00dea/cockpit
```

```sh
npx --no cockpit init                          # previews what it would write; writes nothing yet
npx --no cockpit init --interactive            # type the preview digest, answer each question
npx --no cockpit sync --config cockpit.toml    # rerun after every edit of cockpit.toml
npx --no cockpit check --config cockpit.toml   # fail on drift; run it in CI too
```

The interview proposes values from files it can read (a `package.json` script, a Dockerfile `EXPOSE`,
variable names in `.env.example`) and marks each with where it came from. You confirm every one. Commit
what it wrote: an agent started in the repository then gets the same instructions and skills in each
tool you listed, with the guard live (in Codex once a person trusts its hook). In CI, run `check` or the
[`cockpit-check` action](docs/harness-surfaces.md).

The guard then refuses the same `git push origin main` in all three tools:

```console
$ echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push origin main"}}' \
    | bash .cockpit/guards/bash-guard.sh --harness claudecode
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Refusing push to a declared protected branch."}}

$ ... --harness codexcli
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Refusing push to a declared protected branch."}}

$ ... --harness opencode        # stderr, exit status 2
> cockpit guard: Refusing push to a declared protected branch.
```

One policy, one guard, three transports. Each tool's refusal was also measured in the real tool beside a
control without the hook; the [capability matrix](docs/capability-matrix.md) has the dates and versions.

**Or let your agent do it.** Open your coding agent in the repository and say: *set up cockpit for
this project using the guide in `docs/getting-started.md`* (the
[hosted copy](https://github.com/b0dea/cockpit/blob/main/docs/getting-started.md) works before the
install), or install the setup skill first with `npx skills add b0dea/cockpit --skill adopt-cockpit`.
The guide tells the agent what to ask you and what never to invent.

**Then run the product.** Once `cockpit.toml` declares your Compose files, one command brings the
stack up on its own leased ports, starts the agent inside it and releases the stack when the agent
exits (a `seed` command fills the data; [Environment lifecycle](docs/environment.md) has the rest):

```sh
npx --no cockpit session --config cockpit.toml -- claude
```

[Getting started](docs/getting-started.md) walks through each step; several repositories and a
Compose stack are its second chapter. To watch it all on a throwaway example first, follow the
[tutorial](docs/tutorial.md).

## Capabilities

| Capability | How cockpit does it |
|---|---|
| **Every repository in reach** | Declare each repository once; `setup` clones or finds it, its guides are copied into the root `AGENTS.md` (the one route that loaded in all three tools in the dated runs), and every tool is granted its directory. A changed guide shows as drift until a person runs `sync`, so an agent cannot quietly change what later agents load. |
| **The product running, per checkout** | `session` runs your own Compose files on the live checkouts and leases each checkout, linked worktrees included, a port family, so parallel agents do not collide. `up`, `preflight`, `logs`, `sleep`, `down` and `reset` drive it; the stack stops only when no checkout still holds it, and `reset` wipes only the volumes you declared resettable. |
| **Proof in a real browser** | `browser drive` and `browser screenshot` run a headless browser through your own Playwright project against every declared route on the leased application origin, signed in as a declared role when you ask, and record each screenshot with its digest ([below](#browser-checks)). |
| **Test gates that cannot fake a pass** | `test-run` runs your own targeted or full gate (Vitest, Jest, pytest, Nx, Turborepo, Bazel and others) and reports PASS only for a complete, stable run whose checks all passed; anything else is FAIL, DEGRADED, VOID or PARTIAL. |
| **One guard in every tool** | The same script refuses pushes to protected branches, reads and writes of secret files, and commands aimed at the production hosts you declare. A command it cannot prove read-only goes to a person, or is refused where the tool has no prompt. |
| **Skills for driving it** | Each listed tool gets cockpit's skills for fixing a bug with proof, running a work order, checking the app in a browser and explaining a refusal ([below](#skills)). |
| **Done, measured** | Optional work orders hold a change to an objective, a scope of paths and criteria with checks. In every mode cockpit reruns the checks and fails any change outside scope; the criteria are judged by a fresh read-only agent run, by the checks alone, or by the agent's own report, and the record says which. |
| **MCP servers you approve** | A server your repositories declare reaches an agent only after a person approves its exact SHA-256 in `[mcp.approved]`; a changed declaration needs approval again. |
| **Checked, not assumed** | `check` fails in CI, and when a Claude Code or Codex session starts, if a generated file stops matching `cockpit.toml`. Every diagnostic names what failed and the fix ([example](#drift-checks)). The [capability matrix](docs/capability-matrix.md) records what each tool actually enforced, from dated runs of the real tool; `selftest` checks the tools installed on your machine with probes you write. |

Adopt it in steps: the instructions, skills and guard need only Git and Node.js; the stack switches on
when you declare Compose files (Docker), and agent-run grading when an agent tool is on `PATH` and
signed in.

## A cockpit.toml

`cockpit init` writes this (trimmed here to the meaningful lines) for one repository whose guard
should refuse pushes to `main` and anything that reaches a production database host. Each product
repository is a `[[sibling]]`; a product of several repositories lists several.

```toml
[cockpit]
name = "my-app"
siblings_root = "."

[[sibling]]                      # a repository the agents work in
slug = "my-app"
dir = "."
mount = "always"
acquire = "none"                 # already on disk; "auto" lets setup clone it from a declared remote
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

A two-repository cockpit with its own stack is [examples/compose-first](examples/compose-first/README.md).

## The guard

**What it refuses.** Pushes to `guards.protected_branches` (`main` and `master` by default), reads of
anything under `.secrets` or a declared environment instance, reads and writes of `.env` and `.env.*`
files other than documentation names such as `.env.example` and declared templates, and commands that
reach a declared hosted database or vendor host. `[[guards.allow]]` admits your own commands for good.

**What it sees.** Shell commands in all three tools. In Claude Code also its Edit and Write tools,
through the same hook, and its Read tool, through generated deny rules (a deny beats an allow, so
Claude's Read refuses `.env.example` too; `cat .env.example` works). In OpenCode the plugin restates
its native read, grep and glob as the shell command that reads the same paths.

**What it does with a command it cannot prove read-only.** In Claude Code it asks a person; Codex and
OpenCode have no prompt tier, so there it is refused. `ls`, `git status` and `cat src/x.ts` pass;
`node --test` and `curl https://example.com` do not. `[guards] allow` rules (and a declared build or
test command run from its checkout) widen that. Input it cannot parse is refused.

**Who decides.** `[autonomy]` and `[work.gates]` say which steps an `agent`, a `person` or `ci` may
pass. Everything defaults to `agent` except `reset` and `mcp_approve`. The guard denies an agent's edit
of those tables, and `check` reports any weakening nobody has confirmed.

**Secrets stay out.** Varlock `.env.schema` files are validated without reading values. See
[Safety and autonomy](docs/safety-and-autonomy.md).

## Drift checks

`check` runs locally, in CI and at session start in Claude Code and Codex, and names the fix:

```console
$ npx --no cockpit check --config cockpit.toml
ERROR SURFACE_STATE_CONFLICT [.claude/settings.json]
What failed: this generated file was edited by hand since cockpit last wrote it, and sync does not overwrite hand edits
Why it matters: sync would overwrite content that cockpit did not write
Fix: keep the edit by moving it into cockpit.toml or a surface overlay, ...
```

## Skills

`sync` installs the `cockpit-*` skills for the tools `[surfaces] tools` lists; `adopt-cockpit` is
installed on its own, before cockpit exists. They call cockpit's own commands, so an agent drives the
stack, the tests and the grading the same way in each tool.

| Skill | The agent uses it to |
|---|---|
| `cockpit-fix` | Fix a named bug or failing test: reproduce it with the declared test gate, fix it, prove it with the same gate. Most changes need nothing more. |
| `cockpit-work` | Run a work order: write it, accept it, work inside its scope, check and grade it. |
| `cockpit-browser` | Check what the running app shows, through declared routes, signed-in roles and screenshots. It reports and never edits. Installed when a browser endpoint is declared. |
| `cockpit-explain` | Say what the cockpit does, why it refused something and what to run next, changing nothing. |
| `cockpit-setup` | Add a repository, upgrade, diagnose, or make a repository's guides reach every tool. |
| `adopt-cockpit` | Set cockpit up in a repository that has none yet. Install it with `npx skills add b0dea/cockpit --skill adopt-cockpit`. |

Your own rules, skills and subagents go beside them as [overlays](docs/harness-surfaces.md#ownership-and-extension).

## Work orders

Optional, for a change that must meet criteria someone else set or carry across sessions. A work order
is `workorders/<id>.md`; its YAML front-matter is the contract and the body is yours:

```markdown
---
id: WO-1
objective: The handbook documents how sign-in redirects work.
scope:
  - docs/
criteria:
  - id: AC1
    text: docs/redirects.md exists and names the only origin a redirect may target.
    check: [grep, -q, "same origin", docs/redirects.md]
---
```

`work accept` records the contract, `work check` runs the checks, `work grade` grades it and
`work signoff` closes it. A change outside `scope` fails the grade even when every criterion is met
(this run used `grading = "checks"`):

```console
$ npx --no cockpit work grade --config cockpit.toml --work-order WO-1
...
criteria:
  -
    id: AC1
    note: cockpit ran the check: exit 0
    verdict: met
id: WO-1
mode: checks
outOfScope:
  - src/app.md
state: accepted
ERROR WORK_GRADE_UNSATISFIED: changed outside scope: src/app.md ...
```

`[work] grading` chooses how an order earns done, and `work status` and the committed record always say
which way each one closed:

| `grading` | Who judges the criteria | Closes as |
|---|---|---|
| `independent` (default) | A fresh, read-only run of an agent tool that starts outside the repository and never sees the session that did the work. Run from Claude Code or Codex, another listed tool grades first, with a warning if it falls back to the running tool; with one tool listed it is the same tool in a new run. `--evaluator <tool>` picks it for a run. | `graded` |
| `checks` | cockpit's reruns of each criterion's check, and nothing else. | `checks-passed` |
| `self` | The agent that did the work, with a note saying what it checked. | `self-reported` |

In every mode a failed check or a change outside scope fails the grade. Moving to a weaker mode needs a
person's confirmation, and `[work.gates]` can ask for a person or a CI job to accept, amend or sign off
an order (only the CI job is enforced). To grade a change without an order:
`npx --no cockpit grade --config cockpit.toml --criteria criteria.md`. See
[Work and browser](docs/work-and-browser.md).

## Browser checks

Optional, for evidence of what a person would see. Declare the application's routes, a `[browser]`
table and a small Playwright project of your own, then:

```console
$ npx --no cockpit browser drive --config cockpit.toml --json        # visit every declared route
$ npx --no cockpit browser screenshot --config cockpit.toml --json   # capture each one
$ npx --no cockpit browser drive --config cockpit.toml --role admin  # as a signed-in role
```

The browser runs headless (Chromium by default; Firefox and WebKit are options) and stays on the
application's leased origin: evidence is recorded only for a page that ends there, a second top-level
navigation is refused, and a failure names the URL and the browser's own error code, never page text. Sign-in states are per worker or taken in turns, so parallel
agents do not share a session. The guard asks a person before each browser command unless
`browser.request_preapproval` is set, which is allowed only for isolated, non-production data.

To let an agent drive a browser interactively through Playwright MCP tools, run a browser service in
your own Compose file and declare its `browser.endpoint`; cockpit then publishes the Playwright MCP
server for approval and installs the `cockpit-browser` skill. See
[Browser evidence](docs/work-and-browser.md#browser-evidence).

## How cockpit compares

| Tool | What it owns | Where cockpit differs |
|---|---|---|
| Hand-written `AGENTS.md`, hooks and per-tool settings | Instructions and permissions | cockpit writes those files too, adds the enforcement an instruction cannot give, and tells you when a copy drifts. |
| [rulesync](https://github.com/dyoshikawa/rulesync), [Ruler](https://github.com/intellectronica/ruler) | One set of rules rendered for many agent tools | cockpit bundles rulesync and uses it to render each tool's files, and adds the guard hook, permissions, a drift check for all of it, and a dated record of what each tool enforces. |
| Docker Compose, Tilt, Dev Containers | Running the services | cockpit runs your own `compose.yml` against the checkouts agents edit, with port leases so parallel agents do not collide. It does not replace them. |
| Parallel-agent runners and worktree managers | Several agents at once, each in its own checkout | cockpit does not create the checkouts. It gives each one its own port lease on the real multi-repository stack, and the same guard and grading in every tool. |
| OpenSpec, spec-kit | The plan: specs, tasks, prompts | cockpit owns the environment and the grading. They combine. |

## Status and limits

- **Pre-1.0.** Commands and configuration can change between minors ([release policy](docs/release-policy.md)).
  `npx --no cockpit upgrade --config cockpit.toml` moves the pin and reruns `sync`.
- **Not a sandbox.** The guard stops mistakes, not malicious code running as your user.
- **macOS and Linux.** Native Windows is refused at startup; WSL2 is untested.
- **Codex** runs the guard hook only after a person trusts it once per machine; `cockpit doctor` warns
  until then.
- **Measured, per tool.** The [capability matrix](docs/capability-matrix.md) says what each tool
  enforces, measured on which date and version. Cursor and Grok Build get files but no guard.
- Enabling an MCP server and `reset` (it wipes data) need a person by default.

[When not to use cockpit](docs/faq.md#when-should-i-not-use-cockpit) lists the cases where something
simpler fits better.

## Documentation

| If you want to | Read |
|---|---|
| Set it up for your own product | [Getting started](docs/getting-started.md) |
| Join a team that already uses it | [Joining a team's cockpit](docs/joining-a-team.md) |
| Look up a command or a config field | [CLI reference](docs/cli-reference.md), [Configuration essentials](docs/configuration-essentials.md) |
| Fix a diagnostic | [Troubleshooting](docs/troubleshooting.md) |
| See every page | [Documentation index](docs/README.md) |

## Contributing

Contributions from people and from AI coding agents are welcome: bug reports, a tool cockpit should
support, a capability you measured in a newer tool version, or a fix. Agents start with
[AGENTS.md](AGENTS.md); people with [CONTRIBUTING.md](CONTRIBUTING.md), which also says how the
project is maintained. Ask questions through the
[question template](https://github.com/b0dea/cockpit/issues/new/choose). Report security issues
privately as described in [SECURITY.md](SECURITY.md). Everyone follows the
[Code of Conduct](CODE_OF_CONDUCT.md). Changes are in the [changelog](packages/cockpit/CHANGELOG.md).

## License

[MIT](LICENSE).
