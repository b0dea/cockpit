<p align="center"><img src=".github/assets/cockpit-logo.png" alt="" width="160"></p>

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

cockpit is an open-source CLI for people who run [Claude Code](https://code.claude.com/docs),
[Codex](https://developers.openai.com/codex) or [OpenCode](https://opencode.ai) on a real product. You
write one <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` and review it like code; cockpit
turns it into the environment every agent works in:

- **The same rules in every tool.** Instructions, skills, permissions and one guard hook that refuses
  pushes to protected branches, secret-file reads and commands aimed at production, written into each
  tool's own files, with a CI check that fails the moment any of them drifts.
- **The real product, running.** Every repository in reach, and your own Compose stack on the
  checkouts the agent is editing, on its own ports so parallel agents do not collide.
- **Work graded by something other than the agent that did it.** Optional work orders hold a change to
  criteria you set; a fresh read-only agent run grades it by default, and the grader itself is
  optional ([the choices](docs/work-and-browser.md#how-grading-can-run)).

It holds none of your product code, and it is not a sandbox.

## Why

Agents are good at a change inside one repository. A real product is several repositories, a running
stack and, more and more, several agent tools. That is where they come apart:

- The agent edits the frontend but cannot run the backend it calls, or read that repository's guide.
- Your `CLAUDE.md` never reaches Codex or OpenCode, and copied permissions drift until they disagree.
- Two agents in parallel fight over the same ports and the same database.
- "Tests pass" is the agent's word, and the diff touched files nobody asked it to.

cockpit fixes the environment, not the agent.

## Try it

In a repository you want to protect (macOS or Linux, Git, Node.js as listed in `engines` in
[package.json](packages/cockpit/package.json); no Docker):

```sh
npm install --save-dev --save-exact @b00dea/cockpit
```

```sh
npx --no cockpit init                          # previews what it would write; writes nothing yet
npx --no cockpit init --interactive            # confirm the preview with yes, answer each question
npx --no cockpit sync --config cockpit.toml    # rerun after every edit of cockpit.toml
npx --no cockpit check --config cockpit.toml   # fail on drift; run it in CI too
```

`init` proposes values from files it can read (a `package.json` script, a Dockerfile `EXPOSE`, the
variable names in `.env.example`) and marks where each came from; you confirm every one. Commit what it
wrote. An agent started in the repository now gets the same instructions and skills in each tool you
listed, with the guard live (in Codex once a person trusts its hook). The same push is refused in all
three tools, each through its own transport:

```console
$ echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push origin main"}}' \
    | bash .cockpit/guards/bash-guard.sh --harness claudecode
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Refusing push to a declared protected branch."}}

$ ... --harness codexcli        # the same JSON
$ ... --harness opencode        # on stderr, exit status 2
> cockpit guard: Refusing push to a declared protected branch.
```

And when someone widens a tool's permissions by hand, `check` catches it and names the fix:

```console
$ npx --no cockpit check --config cockpit.toml
ERROR SURFACE_STATE_CONFLICT [.claude/settings.json]
What failed: this generated file was edited by hand since cockpit last wrote it, and sync does not overwrite hand edits
Why it matters: sync would overwrite content that cockpit did not write
Fix: keep the edit by moving it into cockpit.toml or a surface overlay, ...
```

**Or let your agent do it.** Say: *set up cockpit for this project using the guide in
`docs/getting-started.md`*
([hosted copy](https://github.com/b0dea/cockpit/blob/main/docs/getting-started.md)), or install the
skill first: `npx skills add b0dea/cockpit --skill adopt-cockpit`. The guide tells the agent what to
ask you and what never to invent.

**Then run the product.** Once `cockpit.toml` declares your
[Docker Compose](https://docs.docker.com/compose/) files, one command brings the stack up on its own
leased ports, starts the agent inside it and releases the stack when the agent exits:

```sh
npx --no cockpit session --config cockpit.toml -- claude
```

The [tutorial](docs/tutorial.md) runs all of this on a throwaway example.

## Start where you are

Each step is independent. The instructions, skills and guard need only Git and Node.js; the stack
switches on when you declare Compose files (Docker), and agent-run grading when an agent tool is on
`PATH` and signed in.

| You want | Start here |
|---|---|
| The same rules in every tool, for one repository | [One repository, no Docker](docs/getting-started.md#chapter-1-one-repository-one-tool-no-docker) |
| Agents across several repositories, with the product running | [Several repositories and a stack](docs/getting-started.md#chapter-2-several-repositories-and-a-compose-stack) |
| Changes held to criteria you set | [Work orders](docs/work-and-browser.md#write-a-work-order) |
| Your agent to do the setup | [Set up with an agent](docs/getting-started.md#set-up-with-an-agent) |
| To join a team that already uses it | [Joining a team's cockpit](docs/joining-a-team.md) |
| To move an existing scripted setup over, in layers | [Adopt an existing setup](docs/getting-started.md#adopt-an-existing-setup) |

## What you get

| Capability | What it means |
|---|---|
| **[Every repository in reach](docs/harness-surfaces.md#sibling-projection-and-standing-cost)** | Declare each once; `setup` clones or finds it, its guides are copied into the root `AGENTS.md` (the one route that loaded in all three tools in dated runs), and every tool is granted its directory. A changed guide is drift until a person runs `sync`, so an agent cannot quietly change what later agents load. |
| **[The product running, per checkout](docs/environment.md)** | `session` runs your own Compose files on the live checkouts and leases each checkout, worktrees included, a port family. `up`, `logs`, `down` and the rest drive the stack; it stops only when no checkout still holds it, and `reset` wipes only the volumes you declared resettable. |
| **[Parallel work in worktrees](docs/environment.md#serve-a-sibling-from-a-worktree)** | `use` serves a repository from a worktree, so each agent runs the whole product on its own branch. `check` refuses a fixed `container_name` that would make two stacks collide, and `stacks prune` removes what a deleted worktree's stack left behind. |
| **[One guard in every tool](docs/safety-and-autonomy.md)** | The same script lets agents run known development tools inside the cockpit, asks about unknown programs and inline code, and refuses a blocked list: secrets and credentials, writes outside it, force pushes and protected branches, production hosts you declare, and changes to the guard itself. |
| **[Secrets kept out of the agent's context](docs/environment.md#secret-sources-and-environment-schemas)** | The guard refuses `.env` reads; `cockpit env keys` gives an agent the variable names instead, and [Varlock](https://varlock.dev) `.env.schema` files are validated without reading a value. |
| **[Test gates that cannot fake a pass](docs/work-and-browser.md#choose-the-proving-test-tier)** | `test-run` runs your own gate (Vitest, Jest, pytest, Bazel and others) and reports PASS only for a complete, stable run whose checks all passed. A change that deletes, skips or loosens tests is flagged. |
| **[Judged, not just gated](docs/work-and-browser.md#how-an-order-earns-done)** | Optional work orders hold a change to an objective, a scope and criteria. The grader is optional: another agent tool (the default), the same tool in a separate run, a subagent of the working agent, the checks alone, the agent's own report, or none ([how grading can run](docs/work-and-browser.md#how-grading-can-run)). The record always says which. |
| **[Proof in a real browser](docs/work-and-browser.md#browser-evidence)** | `browser drive` and `browser screenshot` visit every declared route through your own [Playwright](https://playwright.dev) project, signed in as a declared role if you ask, and record each screenshot's digest and each route's console errors. |
| **[Skills for driving it](docs/harness-surfaces.md#skills-and-selftest-evidence)** | Each listed tool gets cockpit's skills for fixing a bug with proof, running a work order, explaining a refusal and, once a browser is declared, checking the app in it. They call cockpit's own commands, so the stack, tests and grading work the same way in every tool. |
| **[Agents that unblock themselves](docs/safety-and-autonomy.md#who-decides)** | An agent runs what only reads, fast-forwards or repairs cockpit's own state without asking. Widening access, lowering the grading bar and, by default, deleting data stay a person's. |
| **[MCP servers you approve](docs/harness-surfaces.md#mcp-servers-and-restrictions)** | A server reaches an agent only after a person approves its exact SHA-256; a changed declaration needs approval again. `[mcp.allowed_tools]` limits it to exact tools in Claude Code and Codex; a tool that cannot enforce that does not get the server. |
| **[Decisions and docs kept true](docs/docs-check.md)** | A work order cannot sign off while a recorded decision is unresolved, and `docs check` reports documents citing removed paths. |
| **[Checked, not assumed](docs/capability-matrix.md)** | `check` fails in CI ([a ready-made action](docs/harness-surfaces.md#publish-and-verify) included) and reports drift to the agent as a Claude Code or Codex session starts. The capability matrix records what each tool actually enforced, from dated runs of the real tool. |

## A cockpit.toml

Trimmed to the meaningful lines, for one repository whose guard refuses pushes to `main` and anything
that reaches a production database. A product of several repositories lists several `[[sibling]]`
tables.

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

[guards]
hosted_db_hosts = [ "db.prod.example.com" ]
protected_branches = [ "main", "master" ]

[surfaces]
tools = [ "claudecode", "codexcli", "opencode" ]
```

`sync` renders it into each tool's own files, and `check` fails when any stops matching:

```text
AGENTS.md  CLAUDE.md                     root instructions, one per tool family
.claude/settings.json                    Claude Code hook, permissions and deny rules
.codex/config.toml  .codex/hooks.json    Codex sandbox and guard hook
.opencode/plugin/  opencode.jsonc        OpenCode guard plugin and permissions
.claude/skills/  .agents/skills/  ...    cockpit's skills, per tool
.cockpit/guards/bash-guard.sh            the one guard all three tools call
```

A two-repository cockpit with its own stack is [examples/compose-first](examples/compose-first/README.md).

## Work orders

Optional, for a change that must meet criteria someone else set. A work order is
`workorders/<id>.md`; its front-matter is the contract, and the body is yours:

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
`work signoff` closes it. By default the grader is a fresh, read-only run of an agent tool that starts
outside the repository and never sees the session that did the work; run from inside Claude Code or
Codex, another listed tool grades first. It also judges what a fixed rule cannot: whether a change outside `scope` was
needed and whether a test change was justified. Switching to a weaker mode is refused until a person
confirms it. [How an order earns done](docs/work-and-browser.md#how-an-order-earns-done) has the
modes.

## The guard

- **Allows known tools by default.** A command runs when its executable is a development tool the
  guard knows (Git, `gh`, package managers, interpreters running project files, build and test tools,
  read and text utilities, file utilities inside the cockpit, archive and copy tools, `curl`, cockpit),
  judged by that tool's own rules. A blocked list is refused and no rule overrides it: secrets (`.env`
  and `.env.*` files other than documentation names such as `.env.example`, `.secrets`, declared
  instances, credential stores such as `~/.ssh`, `~/.aws` and other tools' logins, credential-printing
  commands and environment dumps), writes outside the cockpit, force pushes, pushes to protected
  branches (`main` and `master` by default) and rewriting them, commands that reach a declared host,
  Git verbs that would overwrite guard files, global tool configuration and installs, `gh` commands
  that bypass or change branch protection, changes to the guard itself, and privilege escalation or
  downloaded code piped to an interpreter. An agent may run `sync` where `[autonomy] sync = "agent"`,
  except for an edit that widens what agents may do, which a person confirms at `sync --interactive`.
  `[guards] default = "ask"` is the strict mode, which asks for every command the guard cannot prove
  safe.
- **Sees** shell commands in all three tools. In Claude Code also its Edit and Write tools, and its
  Read tool through generated deny rules. Those rules also refuse documentation names such as
  `.env.example`, to Read and to a recognized shell read such as `cat` (measured 2026-11-05), so an
  agent reaches them with `cockpit env keys` and `cockpit env schema`. In OpenCode the plugin
  restates its native read, grep and glob as the shell command that reads the same paths.
- **Asks about what it does not know.** An unknown program and inline code (`python3 -c`, `node -e`,
  an interpreter reading a script from stdin, `find -exec`, `make --eval`, an `awk` that writes a file)
  ask: a prompt in Claude Code, a refusal in Codex and OpenCode, which have no prompt tier. A person
  approves or runs the command, or admits the program with a `[guards] allow` rule, which never
  admits a blocked item. Input it cannot parse is refused.
- **Judges what it can see.** It reads command text only. A program an allowed tool runs, such as
  `node script.js` or a package script, can still read or write anything your account can, and can
  defeat the guard on purpose. It prevents mistakes, not determined circumvention, so the boundaries
  are the tool's own sandbox and server-side branch protection, such as a GitHub ruleset on the
  default branch.

[Safety and autonomy](docs/safety-and-autonomy.md) has the full rules.

## How it compares

- **[rulesync](https://github.com/dyoshikawa/rulesync), [Ruler](https://github.com/intellectronica/ruler):**
  one set of rules for many tools. cockpit bundles rulesync for that, and adds the guard,
  permissions, a drift check over all of it and a dated record of what each tool enforces.
- **Docker Compose, Dev Containers:** they run the services. cockpit runs your own Compose files
  against the checkouts agents edit, with port leases, and does not replace them.
- **OpenSpec, spec-kit:** they own the specification. cockpit owns the environment and the grading; they
  combine.

The [full comparison](docs/faq.md#how-does-cockpit-compare) covers worktree managers and hand-written
settings, and the FAQ says [when not to use cockpit](docs/faq.md#when-should-i-not-use-cockpit).

## Status and limits

- **Pre-1.0.** Commands and configuration can change between minors
  ([release policy](docs/release-policy.md)). `npx --no cockpit upgrade --config cockpit.toml` moves
  the pin and reruns `sync`.
- **Not a sandbox.** The guard stops mistakes, not malicious code running as your user.
- **macOS and Linux.** Native Windows is refused at startup; WSL2 is untested.
- **Codex** runs the guard hook only after a person trusts it once per machine; `cockpit doctor`
  warns until then.
- **Measured, per tool.** The [capability matrix](docs/capability-matrix.md) says what each tool
  enforces, measured on which date and version. Cursor and Grok Build get files but no guard.
  Cockpit is usable once `check` passes; to gather the same native evidence for the tools on your
  machine, a person can optionally run `npx --no cockpit selftest --config cockpit.toml --interactive`.
- Enabling an MCP server and `reset` (it wipes data) need a person by default. Process gates can be
  handed to the agent; guardrails cannot
  ([Fully agentic setup](docs/safety-and-autonomy.md#fully-agentic-setup)).

## Built with

| Product | What cockpit uses it for |
|---|---|
| Claude Code, Codex, OpenCode | The agent tools it writes configuration and guard hooks for, and that run independent grading. |
| Docker Compose | Runs your own stack, per checkout. |
| Playwright | Drives browser checks, through a project of your own. |
| Varlock | Validates `.env.schema` files in `preflight` and `doctor`, from the copy on your `PATH`. |
| [Rulesync](https://github.com/dyoshikawa/rulesync) | Bundled, to spell each tool's generated files. Its [notice](packages/cockpit/libexec/rulesync-generator.NOTICE.md) ships with the package. |

## Documentation and contributing

Every page is in the [documentation index](docs/README.md); start with
[getting started](docs/getting-started.md), and look codes up in
[troubleshooting](docs/troubleshooting.md).

Contributions from people and AI agents are welcome: bug reports, a tool cockpit should support, a
capability you measured in a newer tool version, or a fix. Agents start with [AGENTS.md](AGENTS.md),
people with [CONTRIBUTING.md](CONTRIBUTING.md). Ask through the
[question template](https://github.com/b0dea/cockpit/issues/new/choose), report security issues as
[SECURITY.md](SECURITY.md) says, and follow the [Code of Conduct](CODE_OF_CONDUCT.md). Changes are
in the [changelog](packages/cockpit/CHANGELOG.md).

## License

[MIT](LICENSE).
