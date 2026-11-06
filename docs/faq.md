# FAQ

Short answers, each linking to the page with the detail.

## When should I not use cockpit?

- Your product is one repository and you only need a reproducible toolchain: a dev container or
  Devbox is simpler.
- You need isolation from untrusted code: cockpit is not a sandbox.
- You are on native Windows: every command stops at startup with `CLI_PLATFORM_UNSUPPORTED`, before
  reading or writing anything. Under WSL2 cockpit should behave as on Linux, but that is untested.
- You need a stable tool: cockpit is pre-1.0, and a minor release can change commands, configuration
  and generated layout ([release policy](release-policy.md)).

The non-goals, with reasons, are in [Architecture](architecture.md#non-goals).

## How does cockpit compare?

| Tool | What it owns | Where cockpit differs |
|---|---|---|
| Hand-written `AGENTS.md`, hooks and per-tool settings | Instructions and permissions | cockpit writes those files too, adds the enforcement an instruction cannot give, and tells you when a copy drifts. |
| [rulesync](https://github.com/dyoshikawa/rulesync), [Ruler](https://github.com/intellectronica/ruler) | One set of rules rendered for many agent tools | cockpit bundles rulesync to render each tool's files, and adds the guard hook, permissions, a drift check for all of it, and a dated record of what each tool enforces. |
| Docker Compose, Tilt, Dev Containers | Running the services | cockpit runs your own `compose.yml` against the checkouts agents edit, with port leases so parallel agents do not collide. It does not replace them. |
| Parallel-agent runners and worktree managers | Several agents at once, each in its own checkout | cockpit does not create the checkouts. It gives each its own port lease on the real multi-repository stack, serves a sibling from any worktree with `use`, prunes the stacks of deleted ones, and applies the same guard and grading in every tool. |
| OpenSpec, spec-kit | The plan: specs, tasks, prompts | cockpit owns the environment and the grading. They combine. |

## Do I have to use every agent tool?

No. One tool is a complete setup; see [Choose the tools](harness-surfaces.md#choose-the-tools).

## Are the guards actually enforced?

It depends on the tool. The guard script denies the operation whenever a tool runs it, and fails
closed on input it cannot read; what differs is whether the tool runs it. The
[capability matrix](capability-matrix.md) has each tool's state, and `cockpit selftest` checks the
tools on your machine with [supported native probes](harness-surfaces.md#skills-and-selftest-evidence). In
short: Claude Code and OpenCode are `enforced`; Codex only after a person
[trusts the hook](harness-surfaces.md#trust-the-codex-hook); Cursor and Grok Build get no guard.

## Does cockpit change my product code?

Only in paths the configuration declares and a preview you accepted shows. cockpit writes generated
files into the cockpit checkout, plus declared outputs in a sibling such as an environment file
seeded from its template, and records every generated file. `setup` can clone a missing sibling from
its declared remote. It never rewrites Git remotes or edits undeclared files.

## Can two agents use the same machine at once?

Yes. Each checkout, a linked worktree included, leases its own port family and runs its own stack
([Local URLs and port families](environment.md#local-urls-and-port-families)).

## What happens to my secrets?

`setup` inspects declared secret-file paths without reading or copying their contents. `sync`
creates an ignore boundary for central secret sources before any exist, and where a tool runs the
guard, it denies agents editing or staging declared environment and secret files and reading
secrets. None of this isolates secrets from malicious code running as your user. See
[Secret sources and environment schemas](environment.md#secret-sources-and-environment-schemas).

## Does cockpit send data anywhere?

There is no telemetry. The only request cockpit makes on its own is `doctor` reading the latest
published version from the npm registry, skipped when `CI` or `NO_UPDATE_NOTIFIER` is set. Docker,
Git and your product's own commands make whatever requests they normally make.

## Can I add my own rules and skills?

Yes, through [overlays](concepts.md#cockpit-surface-overlay). See
[Ownership and extension](harness-surfaces.md#ownership-and-extension).

## A command failed with a diagnostic code. What now?

Every refusal prints a code, its target and, where one exists, a fix. Look the code up in
[Troubleshooting](troubleshooting.md), and after a repair run
`cockpit doctor --config ./cockpit.toml --json` to see the current state.
