# Work, grading, browser and testing

<!-- cockpit:verified version=0.0.0 -->

This page is for anyone deciding whether a change needs a direct fix or a durable
[work order](concepts.md#work-order), and then getting it graded independently, checked in a
browser, and proven with the right test tier.

The `work-*` and `browser-*` commands are experimental: their interfaces may change, and each
command's `--help` is the current contract.

## Declare work and the files it may change

The `cockpit-work` skill walks an agent through the loop below. It first asks whether anyone besides the agent must certify the result and, if not, sends the work to `cockpit-fix`. The `cockpit-browser` skill runs the commands in [Browser evidence](#browser-evidence) and reports what it saw, with proof, without editing code.

<!-- cockpit:ref command=work-intake --> Start with `cockpit work-intake --config cockpit.toml --intent intents/task.json`. The intent is a JSON file, not a sentence or a work-order document. Cockpit reads the upstream file, checks which route applies and whether there is capacity, and only then reads a candidate. A fix creates no work-order files. A work-order route returns `candidateRequired: true`; follow the examples below to prepare a draft. Existing orders can be inspected with `--work-order WO-001`.

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
./node_modules/.bin/cockpit work-intake --config cockpit.toml --intent intents/task.json --candidate drafts/task.md
./node_modules/.bin/cockpit work-status --config cockpit.toml --work-order WO-004 --json
```

Successful intake publishes the matched pair under `workorders/WO-004.md` and
`workorders/WO-004.source-audit.json`, retaining `draft` status. It does not accept the work order or record any verification. Continue with [Accept and resume](#accept-and-resume); a person accepts the order interactively as a separate step.

### Programme and capacity

<!-- cockpit:ref command=work-programme-mint --> A programme keeps its intent in one ordered ledger. `cockpit work-programme-mint --config cockpit.toml --programme release` reports the first item not yet minted as a provisional candidate request. Validation checks that earlier items are complete and shippable and that capacity remains. You do not need folders for future items. Publishing a candidate checks the ledger, the identity and the capacity again.

<!-- cockpit:ref schema=workorders.wip_cap --> <!-- cockpit:ref schema=workorders.programme_wip_cap --> <!-- cockpit:ref schema=workorders.attempt_cap --> The configured cockpit, programme WIP and attempt caps are positive integers, with limits set by the [configuration schema](configuration-reference.md). At the configured attempt cap, record root-cause analysis and choose a different approach before execution resumes. Unresolved questions for a human also block execution. Older state stays readable; new execution uses the current policy.

Repository identities accept only exact, nonzero SHA-1 or SHA-256 Git object IDs. The identity check
covers local and remote branches and linked worktrees; tags alone do not reserve an identity.
Malformed or null object IDs are refused rather than recorded as a source.

## Accept and resume

<!-- cockpit:ref command=work-accept --> <!-- cockpit:ref command=work-renew --> Acceptance and renewal need an interactive terminal and the contract digest it displays. JSON, CI and non-interactive calls cannot accept work. The same running process must read the answer; a changed contract or a replayed answer is refused.

<!-- cockpit:ref command=work-status --> <!-- cockpit:ref command=work-resume --> Status keeps proof from local checks apart from proof from CI, the runtime and deployment. Source files you chose as sources are re-read even when they are excluded from repository change tracking; changed bytes make a record stale, and unreadable or missing bytes make it unavailable. Resume picks the next step whose prerequisites are current and that has no unresolved blocker. Acceptance survives a new process: cockpit re-checks it against the stored contract and generation. These local integrity records assume a trusted host. They cannot show who wrote them if a writer can replace both the records and the code that checks them.

<!-- cockpit:ref command=work-recover --> An interrupted operation leaves a named lock behind. Run `cockpit work-recover --config cockpit.toml --lock WO-001` with the exact lock identifier from the refusal to inspect its holder. Recovery needs an explicit `--apply` and a fresh check showing that the recorded process is gone. If the holder is still running, cannot be checked, has a malformed record, or has changed, cockpit refuses to take the lock. Ordinary status and journal recovery never take over a lock, and a malformed lock record is kept for a person to inspect.

<!-- cockpit:ref command=work-record --> `cockpit work-record --config cockpit.toml --work-order WO-001 --event-file events/progress.json` saves heartbeat, root-cause, gap-answer and decision events against the current accepted order. A source-evidence request may name a file inside the project; cockpit reads its bytes and records the digest together with the current contract, the repository revisions and the working-tree content. Each repository entry needs both its revision and its working-tree digest, so incomplete state is refused. Changes to tracked or untracked source files make saved proof stale even when HEAD has not moved. Cockpit's own temporary files in excluded coordination directories do not count as source changes. `work-execute` records attempts and step checks, not `work-record`, and callers cannot claim local, CI, runtime or deployment proof.

<!-- cockpit:ref command=work-metrics --> Metrics show how much history they cover. Time from creation to first movement uses Git creation history and the movement history of the current generation, when they exist. Missing history is reported as partial or unavailable; it is never turned into a duration of zero.

<!-- cockpit:ref command=work-sweep --> <!-- cockpit:ref command=work-reverse --> The sweep groups untouched drafts by creation day and programme. When a group reaches the threshold set in the [work-order composition](../packages/cockpit/src/work-orders/composition.ts), it proposes retaining the earliest identity and parking the others. Applying it saves each order's previous status; reversal checks that the order is still parked and who parked it. An order a person parked by hand is not reversed automatically.

## Verify and grade independently

<!-- cockpit:ref command=work-execute --> <!-- cockpit:ref command=work-review --> <!-- cockpit:ref command=work-grade --> Execution runs the verification commands declared in the accepted contract. After substantial implementation and before grading, `work-review` checks that it is reviewing the current work, then simplifies it and runs an independent code review and security review. Findings, how each was resolved and reruns of affected proof are kept. `work-grade` repeats the final review sequence, runs the final declared verification and then calls the independent grader. It refuses to grade if the listed files have changed. Completion needs the separate review lanes, run by someone other than the author, that the [review sequencer](../packages/cockpit/src/work-orders/review.ts) defines, current results, and an exclusive lock held until cockpit has read the result back and written the completion marker.

A path in the Authority list that starts with `siblings/`, followed by a declared repository name and a relative path, names a file in that repository, even one outside the cockpit directory. Other paths are relative to the cockpit. Paths naming an unknown repository, escaping their root, or going through a symlink are refused. Declared environment instances, credential files and saved browser sign-in state can never be given to the evaluator or used as a source.

Declaring seed data does not give the evaluator access to paths that look like credentials. Public environment templates with names ending in `.example`, `.schema`, `.template` or `.sample` are allowed when no parent directory looks like credentials and the file is neither a declared environment instance nor saved browser sign-in state.

<!-- cockpit:ref path=packages/cockpit/surfaces/agents/evaluator.agent.md --> The shipped evaluator instructions tell it to restrain itself. That restriction is instructed, not enforced: no harness is confirmed to enforce it. Cockpit's source tests and synthetic fixtures show only the local behavior they test; real harness calls and human review need their own checks.

## Browser evidence

<!-- cockpit:ref command=browser-drive --> <!-- cockpit:ref command=browser-accessibility --> <!-- cockpit:ref command=browser-screenshot --> <!-- cockpit:ref command=browser-debugger --> Browser commands use the configured browser setup, the approved Playwright declaration, the current runtime, the declared application routes and a project client that is allowed to connect. Real sign-in additionally ties the session to the current namespace, stack and [holder](concepts.md#holder). With serialized sign-in, the shared state lock is held. With per-worker sign-in, each declared worker holds an exclusive claim across processes; different workers can run at the same time. A missing or stale claim is refused. Application origins come from the recorded application ports; the control proxy is never used as the application origin.

Declared application routes select the starting destinations for driving. Automated operations drive one page; secondary top-level page navigation is refused. HTTP requests and redirects use the browser's native networking, cookies and DNS. A record is made only after navigation ends successfully on a stable page on the current application origin. These checks validate what the browser saw; they do not sandbox outgoing network traffic.

Direct requests to the browser-control addresses and to the underlying server port are refused. Browser control is published only on the host's loopback interface. The proxy checks the exact Host header, rejects requests that come from a browser origin, and accepts only the configured WebSocket handshake. The browser server behind it listens on an unpublished secret path, and the proxy rewrites each accepted public path to that private endpoint. The configured network exposure controls what the browser can reach from the client and does not widen the control listener. The Host, Origin and protocol checks protect loopback access from web pages and DNS-rebinding attacks. They do not verify the identity of other local processes or of services already on the generated stack network.

<!-- cockpit:ref path=packages/cockpit/src/browser/commands.ts --> A screenshot record holds the path of the saved image, which must be inside the project, and its digest. An accessibility record holds the digest of the captured ARIA state; it does not publish a snapshot file and is not a full accessibility audit. Every distinct declared application route is covered; the debugger gives no UI acceptance result.

## Choose the proving test tier

<!-- cockpit:ref command=test-run --> <!-- cockpit:ref schema=testing.gates --> Product stages and gates are declared in configuration. Use the narrowest proving gate for isolated behavior, and the complete declared gate for shared behavior. Documentation-only changes need no behavioral gate when behavior is unchanged.

### Choosing stage commands

<!-- cockpit:ref schema=testing.stages --> Let the product's build or test tool decide what a change affects; cockpit runs it and reports the verdict. Declare the tool's affected or changed-since run as a targeted gate and its complete run as a full gate. A stage command is an argv array run without a shell, from the directory holding `cockpit.toml`, with only `PATH` in its environment and a bounded run time and output size; a stage that exceeds either reports DEGRADED. `--select <kind>:<value>` is appended to every stage command in the gate as those two arguments, so a stage that accepts a selection needs a wrapper that maps it onto the tool's own flags.

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

- **Bazel:** `bazel test //...` as the only stage. Bazel reruns a test only when the test or its dependencies changed (`--cache_test_results` defaults to `auto`), so the full gate is already change-aware.
- **Turborepo:** `npx turbo run test --affected` for the targeted stage and `npx turbo run test` for the full one. Turborepo documents `--affected` as `--filter=...[main...HEAD]`, a comparison of commits, so commit work in progress before relying on it.
- **A runner's changed-file mode:** `npx vitest run --changed origin/main` or `npx jest --changedSince=origin/main` for the targeted stage, and the plain run for the full one.

<!-- cockpit:ref path=packages/cockpit/src/testing/verdict.ts --> Only a complete, stable declared gate whose checks all pass can report PASS. If a check ran and failed, the result is FAIL. If results are unavailable or malformed, it is DEGRADED. Otherwise, if the listed files changed or are stale, it is VOID. Otherwise, a subset or staged run is PARTIAL. A target selector passes your selection to the product's own tool and never substitutes a made-up pass.

<!-- cockpit:ref schema=testing.native_hooks.install --> Native hooks are inspect-only by default. Writing native hook output needs a policy tied to cockpit's ownership record and a measurement of its cost. Rendering a hook and describing how to activate it does not switch on the Git hook path. A person must install it and check separately that it works.

See the generated [CLI reference](cli-reference.md), [configuration reference](configuration-reference.md), [capability matrix](capability-matrix.md) and [diagnostic index](troubleshooting.md) for the current declared surfaces and how far each is confirmed.
