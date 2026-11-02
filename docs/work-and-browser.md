# Work, grading, browser and testing

<!-- cockpit:verified version=0.0.0 -->

This page is for anyone deciding whether a change needs a direct fix or a durable
[work order](concepts.md#work-order), and then getting it graded independently, checked in a
browser, and proven with the right test tier.

Each command's `--help` is its current contract. Work orders require the Codex CLI, on `PATH` and
signed in: the independent reviewers and the grader run in it, whichever agent tool did the work
(see [Verify and grade independently](#verify-and-grade-independently)).

## Declare work and the files it may change

The `cockpit-work` skill walks an agent through the loop below. It first asks whether anyone besides the agent must certify the result and, if not, sends the work to `cockpit-fix`, a direct fix proven with the declared test gate before and after, which needs no intake. The `cockpit-browser` skill runs the commands in [Browser evidence](#browser-evidence) and reports what it saw, with proof, without editing code.

<!-- cockpit:ref command=work intake --> Start with `cockpit work intake --config cockpit.toml --intent intents/task.json`. The intent is a JSON file, not a sentence or a work-order document. Cockpit reads the upstream file, checks which route applies and whether there is capacity, and only then reads a candidate. A fix creates no work-order files. A work-order route returns `candidateRequired: true`; follow the examples below to prepare a draft. Existing orders can be inspected with `--work-order WO-001`.

### Intent descriptor

Save this as `intents/task.json`, relative to the directory containing `cockpit.toml`:

```json
{
  "version": 1,
  "kind": "task",
  "reference": "specs/cache-refresh.md",
  "certification": true,
  "crossSession": false,
  "programme": null
}
```

Every field shown is required, and extra fields are refused.

| Field | Meaning |
| --- | --- |
| `version` | The descriptor format. |
| `kind` | `task`, `issue`, `spec`, `decision` or `programme`. |
| `reference` | An existing file inside the cockpit, even for an external issue: record the request in that file first. |
| `certification` | Whether someone other than the agent must certify the result. |
| `crossSession` | Whether the work must survive a change of session. |
| `programme` | `null` for standalone work, or the declared programme slug. |

`certification: true`, `crossSession: true` or a programme each select a work order. With both booleans false
and `programme: null`, intake returns the fix route without reading a candidate or creating
work-order files.

Spec tools such as OpenSpec or spec-kit already produce that file: point a `spec` intent's
`reference` at the change's proposal or spec, for example `openspec/changes/<name>/proposal.md`.

Create the referenced upstream file before running intake. The examples below use a synthetic
cache: replace its facts and paths with ones you have inspected in your product, and each
verification argument array with the product's real runner and selectors. Each `read` source must
already exist and have been inspected. Run intake without `--candidate` first, and continue only
when it reports the work-order route and capacity.

### Upstream task

Save this as `specs/cache-refresh.md`:

```text
Repair cache refresh so reading a key after refresh returns its latest stored value.
Refresh must preserve other keys and must make a previously absent key readable.
Keep the current cache interface and storage provider.
```

### Draft contract

<!-- cockpit:ref path=packages/cockpit/src/work-orders/contract.ts --> Save this as `drafts/task.md`. Choose an unused work-order ID; intake checks repository refs and linked worktrees as well as current orders. Keep every heading shown and give every acceptance criterion a source, within the parser's limits. Authority lists exact files, including the intent's upstream file, so the draft is tied to the request it answers. Verification rows are argument arrays, not shell strings; they declare checks to run later and do not claim those checks ran.

```markdown
---
id: WO-004
title: Repair cache refresh
status: draft
created: 2026-01-02
---
## Objective
Return the latest stored value after a cache refresh.
## Non-goals
Changing the cache interface or storage provider.
## Context and sources
- S1 | read | specs/cache-refresh.md | Requested cache behavior inspected.
- S2 | read | src/cache.ts | Current cache implementation inspected.
- S3 | inferred | tests/cache.test.ts | Regression cases derived from the requested behavior.
## Authority
- specs/cache-refresh.md
- src/cache.ts
- tests/cache.test.ts
## Acceptance criteria
### AC1
Source: S1
Given: A cached key has an older value than storage.
When: That key is refreshed.
Then: Reading that key returns the latest stored value.
### AC2
Source: S2
Given: Two keys are cached.
When: One key is refreshed.
Then: Reading the other key returns its unchanged value.
### AC3
Source: S3
Given: A stored key is absent from the cache.
When: That key is refreshed.
Then: Reading that key returns its stored value.
## Verification
- AC1 | ["npm","test","--","cache-1"]
- AC2 | ["npm","test","--","cache-2"]
- AC3 | ["npm","test","--","cache-3"]
## Docs impact
none: The current interface remains unchanged.
## Plan
1. [ ] Reproduce stale, unrelated and absent key behavior through the cache interface.
2. [ ] Correct refresh and run the declared verification commands.
## Evidence
- none
## Decisions
- none
```

Source provenance is `read` for inspected file bytes, `inferred` for a reasoned conclusion, or
`operator-confirmed` for a fact a person confirmed. Cockpit re-reads `read` sources; the other
labels do not show that a file was inspected. Record unresolved questions in the audit rather than
inventing answers, and keep the `Evidence` section empty until there is something to record;
intake never certifies the implementation.

### Adjacent source audit

Save this as `drafts/task.source-audit.json`, beside `drafts/task.md`. `sources` must match the
contract's source rows exactly, including order and reason. Each gap is an object with `kind`
(`omission`, `contradiction` or `question`), `reference` and `detail`; unresolved gaps block later
execution. An empty `gaps` array means this audit found no material gaps.

```json
{
  "sources": [
    { "id": "S1", "provenance": "read", "reference": "specs/cache-refresh.md", "reason": "Requested cache behavior inspected." },
    { "id": "S2", "provenance": "read", "reference": "src/cache.ts", "reason": "Current cache implementation inspected." },
    { "id": "S3", "provenance": "inferred", "reference": "tests/cache.test.ts", "reason": "Regression cases derived from the requested behavior." }
  ],
  "gaps": [],
  "skills": {
    "status": "audited",
    "auditor": "source-reviewer",
    "provenance": "read",
    "rows": []
  }
}
```

Before writing the draft, look through the thinking, research, specification and planning skills
installed in the repository and for the user. Name the real auditor, use `read` or
`operator-confirmed` provenance for that look, and record your choices under `skills.rows`. The
empty selection above means the look found no applicable skill; it does not let you skip the look.
Whether a skill applies is a person's judgment: a generated skill list or a file hash does not show
that a skill was found or applies.

Both `skills.auditor` and each skill row's `reference` must start with an ASCII letter or digit,
then contain only ASCII letters, digits, `.`, `_` or `-`, within the
[length limit in the audit reader](../packages/cockpit/src/work-orders/composition.ts); use identifiers
such as `reviewer-name` and `planning`.

Each optional row has `scope` (`repository` or `user`), a logical `reference`, `category`
(`thinking`, `research`, `specification`, `planning` or `other`), boolean `applicable`, a nonempty
`reason`, and `sourceIds` naming contract sources produced or informed by that skill. An applicable
row outside `other` requires linked source IDs. Add the skill's output as a contract source and
match it in the audit; do not use the skill's own text in place of its output. Record inspected but
inapplicable skills with `applicable: false`, the reason, and `sourceIds: []` when no output applies.

Repository rows additionally require `path`, a contained file relative to the cockpit root, and
`sha256`, the lowercase SHA-256 digest of the file you inspected. Cockpit rechecks it.
User rows have neither `path` nor `sha256`: their references are plain names,
not home-directory paths. Rows accept no other fields; include only the fields for their scope.

Publish only after the route accepts the draft:

```sh
./node_modules/.bin/cockpit work intake --config cockpit.toml --intent intents/task.json --candidate drafts/task.md
./node_modules/.bin/cockpit work status --config cockpit.toml --work-order WO-004 --json
```

Successful intake publishes the matched pair under `workorders/WO-004.md` and
`workorders/WO-004.source-audit.json`, retaining `draft` status. It does not accept the work order or record any verification. Continue with [Accept and resume](#accept-and-resume); a person accepts the order interactively as a separate step.

### Programme and capacity

<!-- cockpit:ref command=work programme-mint --> A programme keeps its intent in one ordered ledger. `cockpit work programme-mint --config cockpit.toml --programme release` reports the first item not yet minted as a provisional candidate request. Validation checks that earlier items are complete and shippable and that capacity remains. You do not need folders for future items. Publishing a candidate checks the ledger, the identity and the capacity again.

<!-- cockpit:ref schema=workorders.wip_cap --> <!-- cockpit:ref schema=workorders.attempt_cap --> The configured cockpit WIP and attempt caps are positive integers, with limits set by the [configuration schema](configuration-reference.md); a consumer may lower them, never raise them. A programme holds at most one open work order, which is fixed rather than configured. At the configured attempt cap, record root-cause analysis and choose a different approach before execution resumes. Unresolved questions for a human also block execution. Older state stays readable; new execution uses the current policy.

Repository identities accept only exact, nonzero SHA-1 or SHA-256 Git object IDs. The identity check
covers local and remote branches and linked worktrees; tags alone do not reserve an identity.
Malformed or null object IDs are refused rather than recorded as a source.

## Accept and resume

<!-- cockpit:ref command=work accept --> <!-- cockpit:ref command=work renew --> Acceptance and renewal need an interactive terminal and the contract digest it displays. The prompt shows what that digest binds: the Authority paths, the sources, every acceptance criterion and every verification command, and for renewal the decision being confirmed, with control and bidirectional-override characters replaced, so an edit made after you read the file in an editor is on screen before you accept it. JSON, CI and calls without a terminal on both standard input and standard output are refused. The same running process must read the answer; a changed contract or a replayed answer is refused. That a person, not an agent, gives the answer is instructed, not enforced: cockpit cannot tell a person from a program driving a pseudo-terminal.

To renew an accepted order after changing its contract, set its `status` back to `draft`, add a `## Decisions` row dated no earlier than the acceptance with disposition `accepted` that records the reason and impact, and run `cockpit work renew --config cockpit.toml --work-order WO-001 --interactive`. Until it is renewed, `work status` refuses the order because its execution state belongs to the previous contract.

<!-- cockpit:ref command=work status --> <!-- cockpit:ref command=work resume --> Status keeps proof from local checks apart from proof from CI, the runtime and deployment. Source files you chose as sources are re-read even when they are excluded from repository change tracking; changed bytes make a record stale, and unreadable or missing bytes make it unavailable. Resume picks the next step whose prerequisites are current and that has no unresolved blocker. Acceptance survives a new process: cockpit re-checks it against the stored contract and generation. <!-- cockpit:ref path=packages/cockpit/src/guards/evaluator.ts --> These records carry no secret: each digest is computed from the record's own contents, so anything that can write `.cockpit/work-orders/`, `.cockpit/transactions/` or `.cockpit/actors/` can write a record the next command accepts as the operator's. The guard denies an agent's writes to those directories as [guard controls](safety-and-autonomy.md#configuration-git-and-guard-controls). That holds only for the tool calls the guard inspects, on a harness where it runs, and only for those paths. A process outside the guard can still replace the records: a program a permitted command starts, an interpreter a declared rule admits, or anything run outside an agent.

<!-- cockpit:ref command=work recover --> An interrupted operation leaves a named lock behind. Run `cockpit work recover --config cockpit.toml --lock WO-001` with the exact lock identifier from the refusal to inspect its holder. Recovery needs an explicit `--apply` and a fresh check showing that the recorded process is gone. If the holder is still running, cannot be checked, has a malformed record, or has changed, cockpit refuses to take the lock. Ordinary status and journal recovery never take over a lock, and a malformed lock record is kept for a person to inspect.

<!-- cockpit:ref command=work record --> `cockpit work record --config cockpit.toml --work-order WO-001 --event-file workorders/events/progress.json` saves one of the agent's own events against the current accepted order, attributed to the author. The file holds one JSON object; extra fields are refused:

| Event | Fields | Use |
| --- | --- | --- |
| `heartbeat` | `{"kind":"heartbeat"}` | Show the order is moving. |
| `root-cause` | `kind`, `step`, `approach`, `detail` | Record why an approach failed; needed before retrying at the attempt cap. |
| `gap` | `kind`, `id`, `step`, `question` | Record a question for a person; it blocks execution until answered. |
| `reconcile-execution` | `kind`, `step`, `approach`, `reason` | Clear an execution reservation left by an interrupted `work execute`. |
| `evidence` | `{"kind":"evidence","layer":"source","reference":"<file>"}` | Record a source file's current digest. |

<!-- cockpit:ref command=work answer --> A gap's answer and a decision speak for a person, so `work record` refuses them. A person records them with `cockpit work answer --config cockpit.toml --work-order WO-001 --event-file workorders/events/answer.json --interactive`, which shows the open question and the answer, or the decision, and records it as the operator only after the person types the digest it displays. Like acceptance, it needs an interactive terminal and refuses JSON and CI, and the guard asks a person before an agent's shell runs it (Codex and OpenCode deny it instead); that a person rather than a program driving a pseudo-terminal answers is instructed, not enforced. An agent may draft the file; the person reads and confirms what is recorded.

| Event | Fields | Use |
| --- | --- | --- |
| `resolve-gap` | `kind`, `id`, `answer` | The person's answer to an open gap. |
| `decision` | `kind`, `decision`: `{date, decision, disposition, reason, impact}` | The person's decision; `disposition` is `accepted`, `rejected` or `deferred`. |

A refusal for an unparseable intent, event or programme ledger names the file, the line and column when the parser reports one, and the expected shape; it never quotes the file's bytes.

For `evidence`, cockpit reads the named file inside the project and records its digest together with the current contract, the repository revisions and the working-tree content. Each repository entry needs both its revision and its working-tree digest, so incomplete state is refused. Changes to tracked or untracked source files make saved proof stale even when HEAD has not moved. Cockpit's own coordination files do not count as source changes: the orders and programme ledgers, its private state, and event files under `workorders/events/`. Keep event files there; an event file anywhere else is a source change and makes every earlier step's proof stale. `work execute` records attempts and step checks, not `work record`, and callers cannot claim local, CI, runtime or deployment proof.

<!-- cockpit:ref command=work metrics --> Metrics show how much history they cover. Time from creation to first movement uses Git creation history and the movement history of the current generation, when they exist. Missing history is reported as partial or unavailable; it is never turned into a duration of zero.

<!-- cockpit:ref command=work sweep --> <!-- cockpit:ref command=work reverse --> The sweep groups untouched drafts by creation day and programme. When a group reaches the threshold set in the [work-order composition](../packages/cockpit/src/work-orders/composition.ts), it proposes retaining the earliest identity and parking the others. Applying it saves each order's previous status; reversal checks that the order is still parked and who parked it. An order a person parked by hand is not reversed automatically.

## Verify and grade independently

<!-- cockpit:ref command=work execute --> <!-- cockpit:ref command=work review --> <!-- cockpit:ref command=work grade --> `cockpit work execute --config cockpit.toml --work-order WO-001 --approach "<what you are trying>"` checks the next Plan step: it runs that step's declared verification command and records the attempt. Plan step *n* runs the *n*th Verification row; steps past the last row run the last row, and rows past the last step run only at grading. Run it once per Plan step, after the work for that step, until `work resume` reports the order is awaiting grade. A step whose command fails returns its exit status and the end of its output, records a failed attempt, and leaves the step unchecked; at `workorders.attempt_cap` failures of one approach, record a `root-cause` event and try a different approach. Several accepted orders can be active within the WIP cap; `--work-order` selects which one runs.

Declared verification commands run like product test stages: an argv array without a shell, from the directory holding `cockpit.toml`, with `PATH` and the same non-secret variables, judged by exit status, with the end of long output kept. Each command may run for `workorders.verification_timeout_seconds`; a command that runs longer is stopped and reported as not run, naming that field.

After substantial implementation and before grading, `work review` checks that it is reviewing the current work, then runs an independent simplification review, code review and security review. The reviewers report findings; they do not edit. Findings, how each was resolved and reruns of affected proof are kept. `work grade` repeats the final review sequence, runs every declared verification command and then calls the independent grader. It refuses to grade if the listed files have changed. A grade that does not pass returns each criterion's outcome and reasons and is kept with the order; a passing grade writes the completion marker. Completion needs the separate review lanes, run by someone other than the author, that the [review sequencer](../packages/cockpit/src/work-orders/review.ts) defines, current results, and an exclusive lock held until cockpit has read the result back and written the completion marker.

<!-- cockpit:ref schema=workorders.evaluator_timeout_seconds --> The reviewers and the grader run in the Codex CLI (`codex exec`, in a read-only sandbox), whichever agent tool did the work, so `work review` and `work grade` need `codex` on `PATH` and signed in (`npm install -g @openai/codex`, then `codex login`). Once a cockpit has a `workorders/` directory, `doctor` warns when `codex` is missing. Each run starts in a private directory outside the repository, so Codex does not load the repository's `AGENTS.md` or project configuration, which the agent being graded can write; the request names the repository. The reviewers and the grader are told to treat repository content, work-order text and command output as data to assess, never as instructions; that is instructed, not enforced. Codex runs with no browser tool and the request says so, so the grader is told to grade a criterion about what a person would see as never ran. Each review or grading run may take `workorders.evaluator_timeout_seconds`. When the Codex CLI cannot run, exits with an error or times out, the refusal names the cause it reported.

A path in the Authority list that starts with `siblings/`, followed by a declared repository name and a relative path, names a file in that repository, even one outside the cockpit directory. Other paths are relative to the cockpit. Paths naming an unknown repository, escaping their root, or going through a symlink are refused. Declared environment instances, credential files and saved browser sign-in state can never be given to the evaluator or used as a source.

Declaring seed data does not give the evaluator access to paths that look like credentials. Public environment templates with names ending in `.example`, `.schema`, `.template` or `.sample` are allowed when no parent directory looks like credentials and the file is neither a declared environment instance nor saved browser sign-in state.

<!-- cockpit:ref path=packages/cockpit/surfaces/agents/evaluator.agent.md --> The shipped evaluator instructions tell it to restrain itself. That restriction is instructed, not enforced: no harness is confirmed to enforce it. Cockpit's source tests and synthetic fixtures show only the local behavior they test; real harness calls and human review need their own checks.

## Browser evidence

<!-- cockpit:ref command=browser drive --> <!-- cockpit:ref command=browser accessibility --> <!-- cockpit:ref command=browser screenshot --> <!-- cockpit:ref command=browser debugger --> Browser commands use the configured browser setup, the approved Playwright declaration, the current runtime, the declared application routes and a project client that is allowed to connect. Real sign-in additionally ties the session to the current namespace, stack and [holder](concepts.md#holder). With serialized sign-in, the shared state lock is held. With per-worker sign-in, each declared worker holds an exclusive claim across processes; different workers can run at the same time. A missing or stale claim is refused. Application origins come from the recorded application ports; the control proxy is never used as the application origin.

Declared application routes select the starting destinations for driving. Automated operations drive one page; secondary top-level page navigation is refused. HTTP requests and redirects use the browser's native networking, cookies and DNS. A record is made only after navigation ends successfully on a stable page on the current application origin. These checks validate what the browser saw; they do not sandbox outgoing network traffic.

Direct requests to the browser-control addresses and to the underlying server port are refused, as are requests to any other loopback or `browser.resolver` host outside the application origin, which would reach other services on your machine. Playwright does not route a request the browser follows as a redirect, so a redirect to another loopback port still reaches it. Browser control is published only on the host's loopback interface. The proxy checks the exact Host header, rejects requests that come from a browser origin, and accepts only the configured WebSocket handshake. The browser server behind it listens on an unpublished secret path, and the proxy rewrites each accepted public path to that private endpoint. The configured network exposure controls what the browser can reach from the client and does not widen the control listener. The Host, Origin and protocol checks protect loopback access from web pages and DNS-rebinding attacks. They do not verify the identity of other local processes or of services already on the generated stack network.

<!-- cockpit:ref path=packages/cockpit/src/browser/commands.ts --> A screenshot record holds the path of the saved image, which must be inside the project, and its digest. An accessibility record holds the digest of the captured ARIA state; it does not publish a snapshot file and is not a full accessibility audit. Every distinct declared application route is covered; the debugger gives no UI acceptance result.

When navigation fails, the refusal names the route's URL and the browser's own error code, never page text. `ERR_CONNECTION_REFUSED` or `ERR_SOCKS_CONNECTION_FAILED` means nothing answered at that URL, so check the stack with `doctor` before treating it as a product finding. A certificate error means the browser does not trust the issuer, and an HTTP status means the route answered but not with 2xx.

### Declare a browser

<!-- cockpit:ref schema=browser --> [`examples/minimal`](../examples/minimal/README.md#drive-it-with-a-browser) has a worked `[browser]` declaration that `browser drive`, `browser accessibility` and `browser screenshot` pass against. A browser needs these pieces beside the `[browser]` table:

- **A Playwright MCP declaration.** Declare one server named `playwright` in a JSON file with an `mcpServers` object, listed in a sibling's `derives.mcp_sources`, and approve it by setting `playwright` under `[mcp.approved]` to the sha256 `sync` reports for that declaration. The server starts in its sibling's directory, which must be the cockpit directory itself, so declare that sibling with `dir = "."`. Its arguments must include `browser.images.mcp.reference` and, with a generated runner, `browser.endpoint` exactly once; cockpit rewrites that argument to the leased proxy port.
- **A browser project.** A `package.json` that depends on `@playwright/test` at exactly `browser.project.driver_version`, its npm `package-lock.json`, and both SHA-256 digests in `browser.project`. Keep it apart from the product's own manifest: the runner installs it with `npm ci`, and a `file:` dependency there cannot install in the container. Run `npm ci` in that directory on this machine too, because the browser commands load its Playwright module.
- **Entry points.** Exactly one `kind = "origin"` entry in `environment.entrypoint_derivatives`. Its route, and every other declared entry on the same origin, is a route the commands visit.
- **Artifact roots.** The five `browser.artifacts` paths, listed as `environment.generated_host_paths`. Create the directories before `up`; cockpit hands them to Docker and refuses missing ones.
- **A measured harness row.** The commands drive through a `browser.harnesses` row whose version cockpit has measured; the rendered skill reports other versions as unavailable.

Setting `browser.endpoint` renders a generated runner into `compose.generated.yml`, so it also needs `[environment.generated]`, a runner image pinned by digest with its `architectures`, `browser.project.manifest`, a `browser.proxy.host_variable` that `[ports.bases]` sets to `browser.proxy.proxy_port`, and a `browser.runner_health_measurement`. The runner is published with its leased proxy port, so run `up` first; `sync` refuses until the stack holds a lease. Each missing piece is refused with the field it needs. Without an endpoint, the commands launch a local browser through the same project module.

### How the runner reaches the application

The runner is a Playwright server in a container. The commands connect to it with `browser.network_exposure` (default `<loopback>`), so the container's browser sends requests for `127.0.0.1`, `localhost` and `.localhost` names back through the command's own process. That process runs on your machine, resolves the name there and connects to the published port. The browser therefore opens the same host URL you can open, with the same Host header and cookies, and the receipts report that URL. Any address the exposure does not cover would go to the container's own network, so an origin outside it is refused before the browser starts; an IPv6 literal such as `[::1]` is never covered. Widen `network_exposure` only with a `network_exposure_reason`.

Resolver rules apply to a local browser and to the headed debugger, which both run on your machine. A generated runner resolves names on your machine instead, so its `browser.resolver` rules must map `.localhost` names to `127.0.0.1` or `::1`, which is what that resolver already does. The runner adds no host aliases to its container. For an `https` origin, the container's browser checks the certificate against its own image, so build the runner image with your development CA, as [Named local URLs](environment.md#named-local-urls) describes for every client.

At every start the runner copies the declared manifest and lockfile into a private workspace and runs `npm ci`, which checks each package against the lockfile's integrity digests. A restarted container reuses npm's download cache and does not contact the registry; a recreated one downloads again. Measured on 2026-11-02 with `@playwright/test` 1.64.0, a cold install took about 1.5 seconds and a cached one 0.6 seconds, and a recreated runner was healthy 5 seconds after it started.

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
native_hooks = { install = "inspect" }
```

Nx compares the base with the current working tree, so uncommitted edits count. For other tools, keep the stage shape and change the command:

- **Bazel:** `bazel test //...` for both gates. With the default `--cache_test_results=auto`, Bazel reports cached results for tests whose inputs did not change and passed before, so the full run is already change-aware.
- **Turborepo:** `npx turbo run test --affected` for the targeted stage and `npx turbo run test` for the full one. Turborepo documents `--affected` as `--filter=...[main...HEAD]`, a comparison of commits, so commit work in progress before relying on it.
- **A runner's changed-file mode:** `npx vitest run --changed origin/main` or `npx jest --changedSince=origin/main` for the targeted stage, and the plain run for the full one.

<!-- cockpit:ref path=packages/cockpit/src/testing/verdict.ts --> Only a complete, stable declared gate whose checks all pass can report PASS. If a check ran and failed, the result is FAIL. If results are unavailable or malformed, it is DEGRADED. Otherwise, if the listed files changed or are stale, it is VOID. Otherwise, a subset or staged run is PARTIAL. A target selector passes your selection to the product's own tool and never substitutes a made-up pass. Every verdict returns the same result, with each stage's observation; any verdict but PASS also exits non-zero with `TEST_GATE_UNSATISFIED`.

<!-- cockpit:ref schema=testing.native_hooks.install --> Native hooks are inspect-only by default. Writing native hook output needs a policy tied to cockpit's ownership record and a measurement of its cost. Rendering a hook and describing how to activate it does not switch on the Git hook path. A person must install it and check separately that it works.

See the generated [CLI reference](cli-reference.md), [configuration reference](configuration-reference.md), [capability matrix](capability-matrix.md) and [diagnostic index](troubleshooting.md) for the current declared surfaces and how far each is confirmed.
