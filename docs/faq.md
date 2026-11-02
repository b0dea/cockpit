# FAQ

<!-- cockpit:verified version=0.0.0 -->

Short answers to the questions people ask before and while adopting cockpit, each linking to the
page with the detail.

## What is cockpit, in one sentence?

A CLI that boots a multi-repository product from your local checkouts and gives Claude Code,
Codex CLI and OpenCode the same generated instructions, skills, guards and permissions for it,
and can hand finished work to an independent evaluator.

## When should I not use cockpit?

- Your product is one repository and you only need a reproducible toolchain: a dev container or
  Devbox is simpler.
- You need isolation from untrusted code: cockpit is not a sandbox.
- You are on native Windows: every command stops at startup with `CLI_PLATFORM_UNSUPPORTED`,
  before reading or writing anything, because process management, file publication and the shell
  guards assume macOS or Linux. Under WSL2 cockpit should behave as on Linux, but that is untested.
- You need a stable tool: cockpit is pre-alpha, and its commands, configuration and generated
  layout can still change without a migration path; see
  [Status and limits](../README.md#status-and-limits).

The full list of non-goals, with reasons, is in [Architecture](architecture.md#non-goals).

## How do I install it?

As an exact-pinned, project-local development dependency of the cockpit directory.
[Install cockpit](getting-started.md#install-cockpit) has the steps, including the install from
source.

## Do I have to use every agent tool?

No. `sync` renders surfaces for every built-in harness, so whichever tool you open in the checkout
finds its configuration; `init --target` only picks which harness gets the cockpit-setup skill
first. Custom harnesses can be declared under `[surfaces]`; see
[Harness surfaces](harness-surfaces.md#capability-states).

## Are the guards actually enforced?

It depends on the tool. cockpit's guard script denies the operation whenever a tool runs it, and
fails closed on input it cannot read; what differs is whether the tool runs it. The
[capability matrix](capability-matrix.md) records each tool's state and when it was last probed:

- Claude Code: `enforced`. Its hook refused a push to a protected branch; without the hook, the
  same push went through. Its own Read tool never reaches the hook, so generated `Read` deny rules
  cover secrets there.
- OpenCode: `enforced`. Its plugin refused a protected push and a native read of a secrets file.
- Codex CLI: `enforced` only after a person trusts the hook on that machine. Codex silently skips
  an untrusted hook, and `cockpit doctor` and `cockpit check` report `CODEX_HOOK_UNTRUSTED` until it
  is trusted; see [Trust the Codex hook](harness-surfaces.md#trust-the-codex-hook).
- Cursor and Grok Build: no guard. cockpit writes their files but installs no hook, and nobody has
  confirmed those tools load them.

`cockpit selftest` checks the supported tools installed on your machine, using probe commands you
write for each tool; [Skills and selftest evidence](harness-surfaces.md#skills-and-selftest-evidence)
walks through it.

## Does cockpit change my product code?

Only in paths the configuration declares and a preview you accepted shows. cockpit writes generated
files into the cockpit checkout, plus declared outputs in a sibling repository such as an
environment template, and records every file it wrote. `setup` can clone a missing sibling from
its declared remote. It never rewrites Git remotes or edits undeclared files.

## Can two agents use the same machine at once?

Yes. Each checkout leases its own port family, and each running `up` or `session` is a holder of
the stack. `sleep` stops the stack only when no holder remains, so one agent cannot stop
another's environment. See [Environment](environment.md#lifecycle-and-ownership).

## What happens to my secrets?

`setup` inspects declared secret-file paths without reading or copying their contents. `sync`
creates an ignore boundary for central secret sources before any exist, and the guards deny
agents editing or staging declared environment and secret files. None of this isolates secrets
from malicious code running as your user. See
[Secret sources and environment schemas](environment.md#secret-sources-and-environment-schemas).

## Does cockpit send data anywhere?

There is no telemetry. The only request cockpit makes on its own is `doctor` reading the latest
published version from the npm registry, skipped when `CI` or `NO_UPDATE_NOTIFIER` is set.
Docker, Git and your product's own commands make whatever requests they normally make.

## Why is the configuration so long?

Because every value says where it came from: probes, operations and decisions carry a `provenance`
table with the source file, the date it was observed, and whether it was declared or inferred.
The structure underneath is small; the [tutorial](tutorial.md#read-the-configuration) walks
through it.

## Can I add my own rules and skills?

Yes, through [overlays](concepts.md#cockpit-surface-overlay) under `[surfaces].overlays`.
Replacing a built-in item requires naming it and its SHA-256, so an upstream change to it is
reported before you accept new output. See
[Harness surfaces](harness-surfaces.md#ownership-and-extension).

## A command failed with a diagnostic code. What now?

Every refusal prints a code, the target it applies to and, where one exists, a fix. Look the code
up in [Troubleshooting](troubleshooting.md), and after a repair run
`cockpit doctor --config ./cockpit.toml --json` to see the current state.

## Can my AI agent contribute to cockpit itself?

Yes. Point it at AGENTS.md in the repository root, the working guide for agents, and at
[CONTRIBUTING.md](../CONTRIBUTING.md#verification) for the verification gates.
