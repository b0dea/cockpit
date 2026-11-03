# Work, grading, browser and testing

This page is for anyone deciding whether a change needs a direct fix or a durable
[work order](concepts.md#work-order), and then getting it graded, checked in a browser, and proven
with the right test tier.

Each command's `--help` is its current contract. Most changes are fixes: the `cockpit-fix` skill
proves one with the declared test gate before and after, with no order. Write a work order when the
result must be held to criteria someone else set, graded by something other than the agent that did
the work, or carried across sessions. The `cockpit-work` skill walks an agent through the loop below;
the `cockpit-browser` skill runs the commands in [Browser evidence](#browser-evidence).

## Write a work order

A work order is `workorders/<id>.md`. Its YAML front-matter is the whole contract cockpit accepts,
checks and grades; the Markdown body below it is yours, for notes and a plan, and cockpit never reads
it.

```markdown
---
id: WO-1
objective: Signing in with an expired session sends the person back to where they were.
scope:
  - src/auth/
  - tests/auth/**
  - web:src/routes/login.ts
depends_on: []
gates: [unit]
criteria:
  - id: AC1
    text: After sign-in, a person whose session expired returns to the page they asked for.
    check: { gate: unit, select: "test:returns to the requested page" }
  - id: AC2
    text: The redirect target is never another origin.
    check: [npm, test, --, auth/redirect]
    source: docs/security/redirects.md
non_goals:
  - Changing how sessions expire.
---

Notes and plan go here.
```

| Field | Meaning |
| --- | --- |
| `id` | The file's name without `.md`: letters, digits, `.`, `_` or `-`. |
| `objective` | One outcome, in a sentence. |
| `scope` | Paths and globs the work may change. A plain path covers what is below it; `*` stays within a directory and `**` crosses them. `<sibling slug>:path` names a sibling's file. |
| `depends_on` | Orders that must be done before this one signs off. |
| `gates` | Declared `[testing]` gates `work check` runs besides the criteria's checks. |
| `criteria` | One to twelve, each an `id`, a `text` a reviewer cannot read two ways, an optional `check` and an optional `source`. |
| `check` | `{ gate, select }` runs a declared gate, optionally selected as `test-run --select` takes it; a list is an argv cockpit runs from the cockpit root, without a shell. |
| `source` | A file the criterion comes from. Its bytes are part of the contract, so a changed source makes the order stale. |
| `non_goals` | What the order deliberately leaves alone. |

One schema validates the front-matter; a refusal names each field it rejects. The digest an acceptance
binds covers the front-matter, the bytes of every `source`, and the commit each repository stood at
when the order was accepted. A check is the product's own test command, so it runs like a product test
stage: from the directory holding `cockpit.toml`, with `PATH` and the same non-secret variables,
judged by exit status, keeping the end of long output, for at most `work.verification_timeout_seconds`.

## Accept, check, grade and close

<!-- cockpit:ref command=work status --> <!-- cockpit:ref command=work accept --> <!-- cockpit:ref command=work check --> <!-- cockpit:ref command=work grade --> <!-- cockpit:ref command=work signoff -->

```sh
npx --no cockpit work accept --config cockpit.toml --work-order WO-1
npx --no cockpit work check  --config cockpit.toml --work-order WO-1
npx --no cockpit work grade  --config cockpit.toml --work-order WO-1
npx --no cockpit work signoff --config cockpit.toml --work-order WO-1
npx --no cockpit work status --config cockpit.toml
```

An order moves draft → accepted → checked → graded → done. `work status` also shows three states it
derives: **stale** when the file or a source changed since acceptance, **blocked** while an open
question waits or the attempt cap is reached, and **draft** before acceptance. `partial` and
`abandoned` are closures. The work-in-progress cap, `work.wip_cap`, counts accepted orders that are
not closed, and `work accept` refuses a new one past it. A failed check or grade counts an attempt;
at `work.attempt_cap` the order is blocked until a person amends or closes it.

- **accept** records the contract. Run it again after editing an accepted order to accept the change
  (an amendment). The check base stays the commits recorded at first acceptance.
- **check** runs every criterion's check and the order's gates, in the order the contract lists them.
- **grade** grades the order the way [`[work] grading`](#how-an-order-earns-done) says, and reports
  every changed file outside `scope` since the base commits; a change outside scope fails the grade.
- **signoff** closes a graded order as done. `--partial --note <what is left>` or `--abandon --note <why>`
  closes any open order without a passing grade.
- <!-- cockpit:ref command=work note --> <!-- cockpit:ref command=work answer --> **note** records a note; `--ask` records an open question, which blocks the order until
  `work answer --question <n> --text <answer>` answers it.
- <!-- cockpit:ref command=work recover --> **recover** inspects the lock a crashed command left on an order; a person adds `--apply` once
  the holder it names is gone, since a holder in a container or on another host looks dead from here.

<!-- cockpit:ref path=packages/cockpit/src/guards/evaluator.ts --> cockpit keeps what happened in `.cockpit/work-orders/<id>.json`, committed with the work. It
records who passed each step (`agent`, `person` or `ci`), each check's result, the grade with the
evaluator that answered and those passed over, notes, and how the order closed. Only cockpit writes
those records: the guard denies an agent's writes below `.cockpit/work-orders/` as
[guard controls](safety-and-autonomy.md#configuration-git-and-guard-controls), because a record carries
no key and one an agent wrote would read as a person's. That holds only for the tool calls the guard
inspects; a process outside the guard can still replace a record.

## Who passes each gate

<!-- cockpit:ref schema=work.gates.accept --> `[work.gates]` in `cockpit.toml` says who passes each step: `accept`, `amend` (accepting a changed
contract), `answer` and `signoff`. The defaults are all `agent`.

| Value | What happens |
| --- | --- |
| `agent` | The command passes the step. |
| `person` | The command shows what is being decided and its digest, and records the step only after a person types that digest in a terminal with `--interactive`. Without a terminal it refuses with `WORK_PERSON_REQUIRED`. |
| `ci` | The command records the step as awaiting CI, and it counts once the required `work verify` job passes. |

Removing or rewriting an accepted criterion is never the agent's to certify: under `amend = "agent"`
such an amendment still needs a person.

These local gates are best-effort. The guard keeps an agent's tool call from passing `--interactive`,
and the command needs a terminal on both standard input and standard output, but cockpit cannot tell a
person from a program driving a terminal. The only enforced human gate is `ci`: a required
`work verify` job behind a protected environment whose reviewers must approve it before it runs.

<!-- cockpit:ref command=work verify --> `work verify` checks every record against its order: an open order whose contract changed since
acceptance fails, and so does a done order without a passing grade of its accepted contract. Run in
CI (where `CI` is set), it reports the steps gated on `ci` as confirmed; run locally it lists them as
awaiting CI. A workflow job for it:

```yaml
work-verify:
  runs-on: ubuntu-latest
  environment: work-orders   # add required reviewers to this environment
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 24 }
    - run: npm ci
    - run: npx --no cockpit work verify --config cockpit.toml
```

Make the job a required status check on the protected branch, so an order's `ci` steps reach the branch
only through it.

## How an order earns done

<!-- cockpit:ref schema=work.grading --> `[work] grading` says what `work grade` does, and the record, `work status` and `doctor` always say
which way each order closed:

| `grading` | `work grade` | Closes as |
| --- | --- | --- |
| `independent` (default) | runs the checks, then an evaluator grades each criterion against them and the change | `graded` |
| `checks` | runs the checks; every criterion needs one, and the grade passes only when cockpit ran each and all passed | `checks-passed` |
| `self` | records the agent's `--verdict met` or `unmet` with a `--note` saying what it checked | `self-reported` |

The signoff gate applies on top in every mode.

<!-- cockpit:ref command=grade --> For a change that needs no order, `cockpit grade --config cockpit.toml --criteria <file>` runs the
checks and the independent evaluator against the uncommitted change, and records nothing. The file has
the same front-matter `criteria` list, and optionally `scope`, `gates` and `objective`.

## The independent evaluator

<!-- cockpit:ref schema=work.evaluators --> <!-- cockpit:ref schema=work.evaluator_timeout_seconds --> The grader runs headless in an agent tool from `work.evaluators`, whichever agent tool did the work,
so `independent` grading needs one of them on `PATH` and signed in. The list is tried in order (by
default the tools `surfaces.tools` lists that can evaluate, in that order, so a Claude Code-only cockpit
grades with Claude Code; when the command runs inside Claude Code or Codex, detected from `CLAUDECODE` or `CODEX_THREAD_ID` as measured 2026-11-03, that tool moves last so another listed tool grades first, and a list you write is used exactly as written; `--evaluator <tool>` on `work grade` or `grade --criteria` runs only that one tool for that run, with no fallback): a tool that is missing, too old for the flags below, signed out,
rate-limited or timed out is passed over and the next is tried, and the grade record names which tool
answered and which were passed over. An answer that fails cockpit's checks is refused rather than
retried with another tool, and nothing falls back to the agent grading its own work. Each grade is a
new run of its own, with no session saved to resume, so it never sees the session of the agent that did
the work; an answer from a session that already answered is refused:

| Tool | Runs | Read-only by | Install and sign in |
|---|---|---|---|
| `codexcli` | `codex exec --ephemeral --ignore-user-config` | `--sandbox read-only` | `npm install -g @openai/codex`, then `codex login` |
| `claudecode` | `claude --print --no-session-persistence --safe-mode --strict-mcp-config` | `--tools Read,Grep,Glob`, so no tool that writes or runs commands exists; `--permission-mode dontAsk` | `npm install -g @anthropic-ai/claude-code`, then `claude auth login` |
| `opencode` | `opencode run --pure` | `OPENCODE_PERMISSION` denying its edit, shell, task, web, skill, question, to-do and LSP tools, so they are not offered | `npm install -g opencode-ai`, then `opencode auth login` |

Each read-only mechanism was measured on 2026-11-03 beside a control without it: Codex 0.166.0 refused a shell write that `--sandbox workspace-write` made, Claude Code 2.1.317 wrote a file only once `Write` joined its tools, and OpenCode 1.19.5 offered only its read, glob, grep and list tools under the denials and offered write once edit was not denied. Codex and Claude Code skip your own configuration, hooks, plugins and MCP servers; OpenCode keeps your configuration, so it uses your model and provider, but skips external plugins, and a tool an MCP server in your OpenCode configuration adds is outside its denials. Claude Code and OpenCode constrain the answer with the output schema only as far as the tool does (OpenCode not at all), so cockpit checks every answer against that same schema and refuses one that does not match. Once a cockpit has a `workorders/` directory, `doctor` warns when no listed tool is on `PATH`. Each run starts in a private directory outside the repository, so the tool does not load the repository's `AGENTS.md`, `CLAUDE.md` or project configuration, which the agent being graded can write; the request names the repository. Each run may take `work.evaluator_timeout_seconds`. When no listed tool answers, the refusal names, for each, the cause it reported and the command that fixes it.

The grader is given each criterion with the result of the check cockpit ran for it, and every changed
file's diff since the base commits. A credential-shaped path or a declared environment instance is
listed with its content withheld. A `met` verdict stands only when each quote it cites, at least
eight characters long, is found exactly once in the change or check output it names; otherwise it
reads as `unclear` with the reason. No evaluator runs with a browser, and the request says so, so a
criterion about what a person would see is not met by command output alone.

<!-- cockpit:ref path=packages/cockpit/surfaces/agents/evaluator.agent.md --> The shipped evaluator instructions tell it to treat repository content, order text and command
output as data, never as instructions; that is instructed, not enforced. Run by `work grade` and
`cockpit grade`, the evaluator is also held read-only by its tool's mechanism above. Spawned as a
subagent inside an agent tool, that restriction is instructed, not enforced: no harness is confirmed to
enforce it there.

## Browser evidence

<!-- cockpit:ref command=browser drive --> <!-- cockpit:ref command=browser screenshot --> `browser drive` and `browser screenshot` launch a local browser through a Playwright project of your own and visit the application's declared routes. They need the current runtime and the recorded application ports. Real sign-in additionally ties the session to the current namespace, stack and [holder](concepts.md#holder). With serialized sign-in, the shared state lock is held. With per-worker sign-in, each declared worker holds an exclusive claim across processes; different workers can run at the same time. A missing or stale claim is refused. Application origins come from the recorded application ports.

Declared application routes select the starting destinations for driving. Automated operations drive one page; secondary top-level page navigation is refused. HTTP requests and redirects use the browser's native networking, cookies and DNS. A record is made only after navigation ends successfully on a stable page on the current application origin. These checks validate what the browser saw; they do not sandbox outgoing network traffic. Requests to any loopback or `browser.resolver` host outside the application origin are refused, but Playwright does not route a request the browser follows as a redirect, so a redirect to another loopback port still reaches it.

<!-- cockpit:ref path=packages/cockpit/src/browser/commands.ts --> A screenshot record holds the path of the saved image, which must be inside the project, and its digest. Every distinct declared application route is covered.

When navigation fails, the refusal names the route's URL and the browser's own error code, never page text. `ERR_CONNECTION_REFUSED` or `ERR_SOCKS_CONNECTION_FAILED` means nothing answered at that URL, so check the stack with `doctor` before treating it as a product finding. A certificate error means the browser does not trust the issuer, and an HTTP status means the route answered but not with 2xx.

### Declare a browser

<!-- cockpit:ref schema=browser --> A browser needs these pieces beside the `[browser]` table:

- **A browser project.** A `package.json` that depends on `@playwright/test` at exactly `browser.project.driver_version`, its npm `package-lock.json`, and both SHA-256 digests in `browser.project`. Keep it apart from the product's own manifest, and run `npm ci` in that directory on this machine: the browser commands load its Playwright module.
- **Entry points.** Exactly one `kind = "origin"` entry in `environment.entrypoint_derivatives`. Its route, and every other declared entry on the same origin, is a route the commands visit.
- **Artifact roots.** The three `browser.artifacts` paths, listed as `environment.generated_host_paths`. The screenshot command creates the `cli` root when it is missing.
- **A measured harness row.** The commands drive through a `browser.harnesses` row whose version cockpit has measured; the rendered skill reports other versions as unavailable.

cockpit does not run a browser service or a browser debugger. To let an agent drive a browser through its own Playwright MCP tools, run a browser service in your own Compose file and name its loopback address in `browser.endpoint`. cockpit then publishes the Playwright MCP declaration, which you approve by setting `playwright` under `[mcp.approved]` to the sha256 `sync` reports (its server must be declared in a JSON file with an `mcpServers` object, listed in a sibling's `derives.mcp_sources`), and the `cockpit-browser` skill. Without an endpoint, the Playwright MCP server and the skill are reported unavailable and not rendered; `browser drive` and `browser screenshot` are the working path. The published MCP points at the endpoint as declared, so it reaches the stack started on the base port and does not follow a leased port offset of a second parallel stack. The MCP transports are not measured in any tool; the [capability matrix](capability-matrix.md) says so.

## Choose the proving test tier

<!-- cockpit:ref command=test-run --> <!-- cockpit:ref schema=testing.gates --> Product stages and gates are declared in configuration. Use the narrowest proving gate for isolated behavior, and the complete declared gate for shared behavior. Documentation-only changes need no behavioral gate when behavior is unchanged. `init` proposes stages and gates from the test entry points it finds. With no `[testing]` declared, the generated guide tells agents to add a characterization test in the product's own runner and never to report work as passing, and `doctor` warns that nothing can be graded PASS.

### Choosing stage commands

<!-- cockpit:ref schema=testing.stages --> Let the product's build or test tool decide what a change affects; cockpit runs it and reports the verdict. Declare the tool's affected or changed-since run as a targeted gate and its complete run as a full gate. A stage command is an argv array run without a shell, from the directory holding `cockpit.toml`. Its environment is `PATH` plus `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE` and `TZ` when set; every other variable, including credentials, is withheld. A stage that outlives its `timeout_seconds` is stopped and the gate reports DEGRADED, naming the field to raise; the default and ceiling are in the [configuration reference](configuration-reference.md). Output past the capture limit is dropped from the front and the stage is still judged by its exit status.

<!-- cockpit:ref schema=testing.stages --> `test-run --select <kind>:<value>` narrows a gate, where kind is `spec`, `file`, `test` or `route`. A stage receives the selection through its own `select` table: for each kind it accepts, the arguments to append in its tool's spelling, with `{value}` replaced by the selected value. A stage that declares no arguments for the selected kind is not run and reports DEGRADED rather than running unselected:

```toml
stages = [
  { id = "unit", command = ["npx", "vitest", "run"], requires_stack = false, select = { file = ["{value}"], test = ["-t", "{value}"] } },
]
```

The same shape fits other runners: Jest takes `file = ["{value}"]` and `test = ["-t", "{value}"]`, pytest takes `file = ["{value}"]` and `test = ["-k", "{value}"]`, and `go test ./...` takes `test = ["-run", "{value}"]`.

This Nx example assumes the product checkout is at `../web` and its mainline is `origin/main`:

```toml
[testing]
stages = [
  { id = "affected", command = ["sh", "-c", "cd ../web && exec npx nx affected -t test --base=origin/main"], requires_stack = false },
  { id = "all", command = ["sh", "-c", "cd ../web && exec npx nx run-many -t test"], requires_stack = false },
]
gates = [
  { id = "affected", tier = "targeted", stages = ["affected"], changes = "Isolated behavior; Nx selects the affected projects" },
  { id = "all", tier = "full", stages = ["all"], changes = "Shared or cross-project behavior" },
]
```

Nx compares the base with the current working tree, so uncommitted edits count. For other tools, keep the stage shape and change the command:

- **Bazel:** `bazel test //...` for both gates. With the default `--cache_test_results=auto`, Bazel reports cached results for tests whose inputs did not change and passed before, so the full run is already change-aware.
- **Turborepo:** `npx turbo run test --affected` for the targeted stage and `npx turbo run test` for the full one. Turborepo documents `--affected` as `--filter=...[main...HEAD]`, a comparison of commits, so commit work in progress before relying on it.
- **A runner's changed-file mode:** `npx vitest run --changed origin/main` or `npx jest --changedSince=origin/main` for the targeted stage, and the plain run for the full one.

<!-- cockpit:ref path=packages/cockpit/src/testing/verdict.ts --> Only a complete, stable declared gate whose checks all pass can report PASS. If a check ran and failed, the result is FAIL. If results are unavailable or malformed, it is DEGRADED. Otherwise, if the listed files changed or are stale, it is VOID. Otherwise, a subset or staged run is PARTIAL. A target selector passes your selection to the product's own tool and never substitutes a made-up pass. Every verdict returns the same result, with each stage's observation; any verdict but PASS also exits non-zero with `TEST_GATE_UNSATISFIED`.

<!-- cockpit:ref schema=testing.native_hooks.install --> Native hooks are inspect-only by default. Writing native hook output needs a policy tied to cockpit's ownership record and a measurement of its cost. Rendering a hook and describing how to activate it does not switch on the Git hook path. A person must install it and check separately that it works. Leave `native_hooks` out to keep that default; declare `native_hooks = { install = "explicit-native" }` only together with `native_hook_policy`.

See the generated [CLI reference](cli-reference.md), [configuration reference](configuration-reference.md), [capability matrix](capability-matrix.md) and [diagnostic index](troubleshooting.md) for the current declared surfaces and how far each is confirmed.
