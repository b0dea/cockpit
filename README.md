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

cockpit is an open-source CLI that gives coding agents the environment a real product needs: every
repository in reach, the product running on the checkouts they edit, the same instructions, skills
and guard in [Claude Code](https://code.claude.com/docs),
[Codex](https://developers.openai.com/codex) and [OpenCode](https://opencode.ai), and work checked
against criteria you set. All of it comes from one <!-- cockpit:ref consumer=cockpit.toml -->
`cockpit.toml` you review like code.

## Why

Agents are good at a change inside one repository. A real product is several repositories, a running
stack and, more and more, several agent tools. That is where they come apart:

- The agent edits the frontend but cannot run the backend it calls, or read that repository's guide.
- Your `CLAUDE.md` never reaches Codex or OpenCode, and copied permissions drift until they
  disagree.
- Two agents in parallel fight over the same ports and the same database.
- "Tests pass" is the agent's word, and the diff touched files nobody asked it to.

cockpit fixes the environment, not the agent. It renders one configuration into each tool's own
files, runs your stack, and fails CI when a generated file drifts. It holds none of your product
code.

## Try it

In a repository you want to protect (macOS or Linux, Git, Node.js as listed in `engines` in
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

`init` proposes values from files it can read and marks where each came from; you confirm every one.
Commit what it wrote. An agent started in the repository now gets the same instructions and skills
in each tool you listed, with the guard live (in Codex once a person trusts its hook):

```console
$ echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push origin main"}}' \
    | bash .cockpit/guards/bash-guard.sh --harness claudecode
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Refusing push to a declared protected branch."}}
```

`--harness codexcli` and `--harness opencode` refuse the same push through their own transports.

**Or let your agent do it.** Say: *set up cockpit for this project using the guide in
`docs/getting-started.md`*
([hosted copy](https://github.com/b0dea/cockpit/blob/main/docs/getting-started.md)), or install the
skill first: `npx skills add b0dea/cockpit --skill adopt-cockpit`.

**Then run the product.** Once `cockpit.toml` declares your
[Docker Compose](https://docs.docker.com/compose/) files, one command brings the stack up on its own
leased ports, starts the agent inside it and releases the stack when the agent exits:

```sh
npx --no cockpit session --config cockpit.toml -- claude
```

The [tutorial](docs/tutorial.md) runs all of this on a throwaway example.

## Start where you are

Each is independent, and only the stack needs Docker.

| You want | Start here |
|---|---|
| The same rules in every tool, for one repository | [One repository, no Docker](docs/getting-started.md#chapter-1-one-repository-one-tool-no-docker) |
| Agents across several repositories, with the product running | [Several repositories and a stack](docs/getting-started.md#chapter-2-several-repositories-and-a-compose-stack) |
| Changes held to criteria you set | [Work orders](docs/work-and-browser.md#write-a-work-order) |
| Your agent to do the setup | [Set up with an agent](docs/getting-started.md#set-up-with-an-agent) |
| To join a team that already uses it | [Joining a team's cockpit](docs/joining-a-team.md) |
| To move an existing scripted setup over | [Adopt an existing setup](docs/getting-started.md#adopt-an-existing-setup) |

## What you get

| Capability | What it means |
|---|---|
| **[Every repository in reach](docs/harness-surfaces.md#sibling-projection-and-standing-cost)** | Declare each once; `setup` clones or finds it, its guides are copied into the root `AGENTS.md`, and every tool is granted its directory. A changed guide is drift until a person runs `sync`, so an agent cannot quietly change what later agents load. |
| **[The product running, per checkout](docs/environment.md)** | `session` runs your own Compose files on the live checkouts and leases each checkout, worktrees included, a port family, so parallel agents do not collide. |
| **[One guard in every tool](docs/safety-and-autonomy.md)** | The same script refuses pushes to protected branches, reads and writes of secret files, and commands aimed at production hosts you declare. |
| **[Test gates that cannot fake a pass](docs/work-and-browser.md#choose-the-proving-test-tier)** | `test-run` runs your own gate and reports PASS only for a complete, stable run whose checks all passed. A change that deletes, skips or loosens tests is flagged. |
| **[Judged, not just gated](docs/work-and-browser.md#how-an-order-earns-done)** | Optional work orders hold a change to an objective, a scope and criteria. A fresh read-only agent run grades it by default, or the checks alone, or the agent's own report, and the record says which. |
| **[Proof in a real browser](docs/work-and-browser.md#browser-evidence)** | `browser drive` and `browser screenshot` visit every declared route through your own [Playwright](https://playwright.dev) project and record what they saw. |
| **[Agents that unblock themselves](docs/safety-and-autonomy.md#who-decides)** | An agent runs what only reads, fast-forwards or repairs cockpit's own state without asking. Widening access, and by default deleting data, stays a person's. |
| **[MCP servers you approve](docs/harness-surfaces.md#mcp-servers-and-restrictions)** | A server reaches an agent only after a person approves its exact SHA-256; a changed declaration needs approval again. |
| **[Decisions and docs kept true](docs/docs-check.md)** | A work order cannot sign off while a recorded decision is unresolved, and `docs check` reports documents citing removed paths. |
| **[Checked, not assumed](docs/capability-matrix.md)** | `check` fails in CI when a generated file stops matching `cockpit.toml`, and the capability matrix records what each tool actually enforced, from dated runs of the real tool. |

## A cockpit.toml

Trimmed to the meaningful lines, for one repository whose guard refuses pushes to `main` and
anything that reaches a production database. A product of several repositories lists several
`[[sibling]]` tables.

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
tools = [ "claudecode", "codexcli" ]
```

## The guard

- **Refuses** pushes to protected branches (`main` and `master` by default), reads of anything under
  `.secrets` or a declared environment instance, reads and writes of `.env` and `.env.*` files other
  than documentation names such as `.env.example`, and commands that reach a declared host.
- **Sees** shell commands in all three tools. In Claude Code also its Edit and Write tools, and its
  Read tool through generated deny rules. Those rules also refuse documentation names such as
  `.env.example`, to Read and to a recognized shell read such as `cat` (measured 2026-11-05), so an
  agent reaches them with `cockpit env keys` and `cockpit env schema`. In OpenCode the plugin
  restates its native read, grep and glob as the shell command that reads the same paths.
- **Cannot prove a command read-only?** Claude Code asks a person; Codex and OpenCode have no prompt
  tier, so there it is refused. `[guards] allow` rules widen that. Input it cannot parse is refused.

[Varlock](https://varlock.dev) `.env.schema` files are validated without reading values, once
committed. [Safety and autonomy](docs/safety-and-autonomy.md) has the full rules.

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
- Enabling an MCP server and `reset` (it wipes data) need a person by default.

The FAQ says [when not to use cockpit](docs/faq.md#when-should-i-not-use-cockpit) and
[how it compares](docs/faq.md#how-does-cockpit-compare) with similar tools.

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
