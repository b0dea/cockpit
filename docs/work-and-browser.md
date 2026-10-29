# Work, grading, browser and testing

<!-- cockpit:verified version=0.0.0 -->

This guide is for users choosing between a direct fix and a durable work order, then collecting
independent grading, browser evidence and the right test tier for that choice.

All `work-*` and `browser-*` commands are experimental. Their interfaces may change before a
stable release; use the command-specific help as the current contract.

## Declare work and preserve its authority

The experimental `cockpit-work` skill walks an agent through the loop below: it first asks whether anyone besides the agent must certify the result and, if not, sends the work to `cockpit-fix`. The `cockpit-browser` skill drives the browser commands in [Browser evidence](#browser-evidence) and reports findings with evidence without editing code.

<!-- cockpit:ref command=work-intake --> Start with `cockpit work-intake --config cockpit.toml --intent intents/task.json`. The intent is a JSON file, not a sentence or a work-order document. Cockpit reads its upstream artifact, checks routing and capacity, and only then reads a candidate. A fix creates no work-order files. A work-order route returns `candidateRequired: true`; follow the examples below to prepare a draft. Existing orders can be inspected with `--work-order WO-001`.

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

Every field shown is required; extra fields refuse. `version` is the descriptor format. `kind` is
`task`, `issue`, `spec`, `decision` or `programme`; `reference` is an existing contained file,
even for an external issue: first record the relevant request in that file. `certification` and
`crossSession` are booleans describing independent certification and durable handoff. Either true
selects a work order. `programme` is `null` for standalone work or the declared programme slug;
a programme also selects a work order. With both booleans false and `programme: null`, intake
returns the fix route without reading a candidate or creating work-order files.

Create the referenced upstream file before running the command. These examples adapt an existing
product: each `read` source must already exist and have been inspected. Replace the synthetic cache
facts and paths with inspected product facts, and each verification argument array with that
product's actual runner and selectors. Run intake without `--candidate` first; proceed only when
it reports the work-order route and capacity.

### Upstream task

Save this as `specs/cache-refresh.md`:

```text
Repair cache refresh so reading a key after refresh returns its latest stored value.
Refresh must preserve other keys and must make a previously absent key readable.
Keep the current cache interface and storage provider.
```

### Draft contract

<!-- cockpit:ref path=packages/cockpit/src/work-orders/contract.ts --> Save this as `drafts/task.md`. Choose an unused work-order ID; intake checks repository refs and linked worktrees as well as current orders. Keep every canonical heading and the parser's bounded, sourced acceptance criteria. Authority lists exact files, including the intent's upstream file, so the draft binds the request being admitted. Verification rows are argument arrays, not shell strings; they declare future checks and do not claim those checks ran.

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
`operator-confirmed` for a fact the operator confirmed. Cockpit re-reads `read` sources; other
provenance labels do not establish file inspection. Keep those distinctions truthful and record
unresolved questions in the audit rather than inventing answers. Keep the draft's `Evidence` empty
until evidence exists; intake never certifies the implementation.

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

Inspect applicable repository- and user-installed thinking, research, specification and planning
skills before compiling the draft. Name the actual auditor, use `read` or `operator-confirmed`
provenance for that inspection, and record its choices under `skills.rows`. The audited empty
selection above records that inspection found no applicable skill; it is not permission to skip
inspection or the source audit. Semantic applicability is instructed and human-reviewed. A generated
skill inventory or a byte hash alone does not prove discovery or applicability.

Both `skills.auditor` and each skill row's `reference` must start with an ASCII letter or digit,
then contain only ASCII letters, digits, `.`, `_` or `-`, within the
[audit reader's length bound](../packages/cockpit/src/work-orders/composition.ts); use identifiers
such as `reviewer-name` and `planning`.

Each optional row has `scope` (`repository` or `user`), a logical `reference`, `category`
(`thinking`, `research`, `specification`, `planning` or `other`), boolean `applicable`, a nonempty
`reason`, and `sourceIds` naming contract sources produced or informed by that skill. An applicable
row outside `other` requires linked source IDs. Add the skill's output as a contract source and
match it in the audit; do not substitute the skill text for its output. Record inspected but
inapplicable skills with `applicable: false`, the reason, and `sourceIds: []` when no output applies.

Repository rows additionally require `path`, a contained file relative to the cockpit root, and
`sha256`, the lowercase SHA-256 digest of its inspected bytes. Cockpit rechecks that binding.
User rows have neither `path` nor `sha256`: their references stay opaque logical identifiers,
not home-directory paths. All row fields are closed; include only the fields for its scope.

Publish only after the route admits the draft:

```sh
cockpit work-intake --config cockpit.toml --intent intents/task.json --candidate drafts/task.md
cockpit work-status --config cockpit.toml --work-order WO-004 --json
```

Successful intake publishes the matched pair under `workorders/WO-004.md` and
`workorders/WO-004.source-audit.json`, retaining `draft` status. It creates no accepted state or
verification proof. Continue through [Accept and resume](#accept-and-resume); the operator's
interactive acceptance is a separate step.

### Programme and capacity

<!-- cockpit:ref command=work-programme-mint --> Programme intent remains in one ordered ledger. `cockpit work-programme-mint --config cockpit.toml --programme release` reports the first unminted item as a provisional candidate request. Candidate validation checks predecessor completion, shippability and remaining capacity. Future item folders are unnecessary. Candidate publication rechecks the current ledger, identity and capacity.

<!-- cockpit:ref schema=workorders.wip_cap --> <!-- cockpit:ref schema=workorders.programme_wip_cap --> <!-- cockpit:ref schema=workorders.attempt_cap --> The configured cockpit, programme WIP and attempt caps are positive integers bounded by the [configuration schema](configuration-reference.md). At the configured attempt cap, record root-cause analysis and choose a different approach before execution resumes. Unresolved human-input gaps also block execution. Historical state remains readable; current execution uses the issued policy.

Repository identities admit exact, nonzero SHA-1 or SHA-256 Git object IDs. Identity inspection
covers local and remote branches and linked worktrees; tags alone do not reserve an identity.
Malformed or null object IDs refuse instead of becoming durable source evidence.

## Accept and resume

<!-- cockpit:ref command=work-accept --> <!-- cockpit:ref command=work-renew --> Acceptance and renewal require an interactive terminal and the displayed current contract digest. JSON, CI and noninteractive calls cannot accept work. An answer is consumed by the same running process; changed contracts and replayed continuations refuse.

<!-- cockpit:ref command=work-status --> <!-- cockpit:ref command=work-resume --> Status separates checked local proof from CI, runtime and deployment evidence. Selected source evidence is re-read even when its file is excluded from repository change observations; changed bytes are stale and unreadable or missing bytes are unavailable. Resume selects the next step with current prerequisites and no unresolved blocker. Durable acceptance survives a new process; it is re-admitted from its stored exact contract and generation rather than reconstructed by casting JSON into an issued value. These local integrity records assume a trusted host; they do not establish signer identity against a writer that can replace both the records and enforcement code.

<!-- cockpit:ref command=work-recover --> Interrupted transactions retain a named owner lock. Run `cockpit work-recover --config cockpit.toml --lock WO-001` with the exact lock identifier from the refusal to inspect its holder. Recovery requires an explicit `--apply` and fresh positive evidence that the recorded process is absent. Live, unavailable, malformed, or changed holder evidence refuses reclamation. Ordinary status and journal recovery never reclaim a lock; malformed owner evidence remains preserved for operator inspection.

<!-- cockpit:ref command=work-record --> `cockpit work-record --config cockpit.toml --work-order WO-001 --event-file events/progress.json` persists heartbeat, root-cause, gap-answer and decision events through the current accepted state and its owned writer. A source-evidence request may select a contained file; cockpit observes its bytes and binds the digest, current contract, repository revisions and working-tree content. Every repository binding requires both its revision and working-tree digest, so incomplete state refuses before use. Tracked and untracked source changes invalidate retained proof even when HEAD is unchanged. Cockpit's own transient files inside excluded coordination directories do not count as source changes. Attempts and step checks remain execution-owned, and callers cannot assert local, CI, runtime or deployment proof.

<!-- cockpit:ref command=work-metrics --> Metrics expose their retained history coverage. Creation-to-first-movement time uses bounded Git creation evidence and immutable current-generation movement history when available. Missing history remains partial or unavailable; it is never converted to a zero-duration result.

<!-- cockpit:ref command=work-sweep --> <!-- cockpit:ref command=work-reverse --> The sweep groups untouched drafts by creation day and programme. When a group reaches the threshold owned by the [work-order composition](../packages/cockpit/src/work-orders/composition.ts), it proposes retaining the earliest identity and parking the others. Applying it persists the prior status; reversal checks the current parked state and its recorded provenance. Human parking is not automatically reversed.

## Verify and grade independently

<!-- cockpit:ref command=work-execute --> <!-- cockpit:ref command=work-review --> <!-- cockpit:ref command=work-grade --> Execution uses the accepted contract’s declared verification commands. After substantial implementation and before grading, `work-review` authenticates the current subject and performs simplification followed by independent code and security review. Findings, dispositions and affected-proof reruns are retained. `work-grade` repeats the final review sequence, runs final declared verification and then invokes the independent grader. Changed authority refuses before grading. Completion requires the distinct non-author review lanes owned by the [review sequencer](../packages/cockpit/src/work-orders/review.ts), current evidence and an exclusive lock through readback and the completion sentinel.

Authority references beginning with `siblings/`, followed by a declared repository name and a relative path, select files within that repository, including repositories outside the cockpit directory. Unqualified references remain relative to the cockpit. References to unknown repositories, escaped paths or symlinks are refused. Declared environment instances, credential files and browser authentication state cannot become evaluator artifacts or source evidence.

Environment seeding declarations do not authorize evaluator access to credential-shaped paths. Public environment template names ending in `.example`, `.schema`, `.template` or `.sample` are allowed when no parent directory is credential-shaped and the file is neither a declared environment instance nor browser authentication state.

<!-- cockpit:ref path=packages/cockpit/surfaces/agents/evaluator.agent.md --> The shipped evaluator instructions describe its restraint. That restriction is instructed: it does not establish a native harness enforcement guarantee. Source tests and synthetic process fixtures establish their recorded local behavior; actual harness calls and human assessment require their own evidence.

## Browser evidence

<!-- cockpit:ref command=browser-drive --> <!-- cockpit:ref command=browser-accessibility --> <!-- cockpit:ref command=browser-screenshot --> <!-- cockpit:ref command=browser-debugger --> Browser operations consume the configured posture, approved Playwright declaration, issued runtime, declared application routes and an authenticated project client. Real authentication additionally binds the current namespace, stack and coordination owner. Serialized authentication holds the shared state lock. Per-worker authentication holds an exclusive claim for its declared worker across processes; distinct workers can operate concurrently. Missing or stale authority refuses. Application origins come from retained application ports; the control proxy does not become the application origin.

Declared application routes select the starting destinations for driving. Automated operations drive one page; secondary top-level page navigation is refused. HTTP requests and redirects use the browser's native networking, cookies and DNS. A receipt requires a successful terminal navigation and a stable displayed document on the current application origin. These checks verify evidence; they do not provide a network egress sandbox.

Direct requests to known browser-control authorities and the underlying server port are refused. Browser-control publication is restricted to host loopback. The proxy checks the exact Host, rejects browser-origin requests and admits only the configured WebSocket handshake. Its upstream browser server uses an unpublished capability path; the proxy rewrites an admitted public path to that private endpoint. The configured network exposure controls browser-to-client reach and does not widen the control listener. Host, Origin and protocol checks protect host-loopback access from browser-origin and DNS-rebinding requests. They do not authenticate arbitrary local processes or services already on the generated stack network.

<!-- cockpit:ref path=packages/cockpit/src/browser/commands.ts --> Screenshot receipts bind a contained artifact path and digest. Accessibility receipts retain the digest of the bounded captured ARIA state; they do not publish an accessibility snapshot file or establish complete accessibility certification. Every unique declared application route is covered; the debugger supplies no UI acceptance evidence. Native capability rows retain their measured version and date, and unavailable rows remain non-authorizing.

## Choose the proving test tier

<!-- cockpit:ref command=test-run --> <!-- cockpit:ref schema=testing.gates --> Product stages and gates are declared in configuration. Use the narrowest proving gate for isolated behavior, and the complete declared gate for shared behavior. Documentation-only changes need no behavioral gate when behavior is unchanged.

<!-- cockpit:ref path=packages/cockpit/src/testing/verdict.ts --> Only a complete, stable declared gate with passing observations can report PASS. Executed disagreement reports FAIL; unavailable or malformed evidence reports DEGRADED; otherwise changed or stale authority reports VOID; otherwise a subset or staged run reports PARTIAL. A target selector forwards the declared selection to the product tool and never substitutes a synthetic pass.

<!-- cockpit:ref schema=testing.native_hooks.install --> Native hooks are inspect-only by default. Explicit native output requires an authenticated ownership-bound policy and bounded cost measurement. Rendering a hook and an activation description does not activate the Git hook path. Actual installation and native effectiveness require separate operator evidence.

See the generated [CLI reference](cli-reference.md), [configuration reference](configuration-reference.md), [capability matrix](capability-matrix.md) and [diagnostic index](troubleshooting.md) for the current declared surfaces and evidence strength.
