# Work, grading, browser and testing

<!-- cockpit:verified version=0.0.0 -->

All `work-*` and `browser-*` commands are experimental. Their interfaces may change before a
stable release; use the command-specific help as the current contract.

## Declare work and preserve its authority

The experimental `cockpit-work` skill walks an agent through the loop below: it first asks whether anyone besides the agent must certify the result and, if not, sends the work to `cockpit-fix`. The `cockpit-browser` skill drives the browser commands in [Browser evidence](#browser-evidence) and reports findings with evidence without editing code.

<!-- cockpit:ref path=packages/cockpit/src/work-orders/contract.ts --> Work orders use the bounded executable document contract owned by [the work-order parser](../packages/cockpit/src/work-orders/contract.ts). Its frontmatter, source provenance, Authority paths, three to seven acceptance criteria, verification commands and ordered plan are validated together. Invalid or contradictory documents refuse before work starts.

<!-- cockpit:ref command=work-intake --> Start with `cockpit work-intake --config cockpit.toml --intent intents/task.json`. The bounded descriptor links a task, issue, specification, decision or programme artifact and declares whether certification or a durable handoff is needed. Routing and current capacity are checked before any candidate is read or draft is written. A fix creates no work-order files. A work-order route reports that a candidate is needed; submit its contained path with `--candidate drafts/task.md` to validate and publish the draft and source audit. Existing orders can be inspected with `--work-order WO-001`.

<!-- cockpit:ref path=packages/cockpit/surfaces/skills/procedures/onboarding.md --> Preparation records the instructed, human-reviewed inspection of applicable repository- and user-installed thinking, research, specification and planning skills. The adjacent `.source-audit.json` records the named auditor, provenance, explicit capability choices and linked output sources. An audited empty selection records absence. Repository references bind contained file bytes; user references remain opaque logical identifiers. Semantic applicability is instructed and human-reviewed. A hash proves byte identity only; generated skill inventory is not discovery evidence. Missing optional skills never skip the required source audit.

<!-- cockpit:ref command=work-programme-mint --> Programme intent remains in one ordered ledger. `cockpit work-programme-mint --config cockpit.toml --programme release` reports the first unminted item as a provisional candidate request. Candidate validation checks predecessor completion, shippability and remaining capacity. Future item folders are unnecessary. Candidate publication rechecks the current ledger, identity and capacity.

<!-- cockpit:ref schema=workorders.wip_cap --> <!-- cockpit:ref schema=workorders.programme_wip_cap --> <!-- cockpit:ref schema=workorders.attempt_cap --> The configured cockpit and programme WIP caps are positive integers bounded by their framework maxima of three and one. The attempt cap may be one or two. After that many failures, record root-cause analysis and choose a different approach before execution resumes. Unresolved human-input gaps also block execution. Historical state remains readable; current execution uses the issued policy.

Repository identities admit exact, nonzero SHA-1 or SHA-256 Git object IDs. Identity inspection
covers local and remote branches and linked worktrees; tags alone do not reserve an identity.
Malformed or null object IDs refuse instead of becoming durable source evidence.

## Accept and resume

<!-- cockpit:ref command=work-accept --> <!-- cockpit:ref command=work-renew --> Acceptance and renewal require an interactive terminal and the displayed current contract digest. JSON, CI and noninteractive calls cannot accept work. An answer is consumed by the same running process; changed contracts and replayed continuations refuse.

<!-- cockpit:ref command=work-status --> <!-- cockpit:ref command=work-resume --> Status separates checked local proof from CI, runtime and deployment evidence. Selected source evidence is re-read even when its file is excluded from repository change observations; changed bytes are stale and unreadable or missing bytes are unavailable. Resume selects the next step with current prerequisites and no unresolved blocker. Durable acceptance survives a new process; it is re-admitted from its stored exact contract and generation rather than reconstructed by casting JSON into an issued value. These local integrity records assume a trusted host; they do not establish signer identity against a writer that can replace both the records and enforcement code.

<!-- cockpit:ref command=work-recover --> Interrupted transactions retain a named owner lock. Run `cockpit work-recover --config cockpit.toml --lock WO-001` with the exact lock identifier from the refusal to inspect its holder. Recovery requires an explicit `--apply` and fresh positive evidence that the recorded process is absent. Live, unavailable, malformed, or changed holder evidence refuses reclamation. Ordinary status and journal recovery never reclaim a lock; legacy anonymous locks require operator inspection.

<!-- cockpit:ref command=work-record --> `cockpit work-record --config cockpit.toml --work-order WO-001 --event-file events/progress.json` persists heartbeat, root-cause, gap-answer and decision events through the current accepted state and its owned writer. A source-evidence request may select a contained file; cockpit observes its bytes and binds the digest, current contract, repository revisions and working-tree content. Tracked and untracked source changes invalidate retained proof even when HEAD is unchanged; legacy revision-only proof must be refreshed. Cockpit's own transient files inside excluded coordination directories do not count as source changes. Attempts and step checks remain execution-owned, and callers cannot assert local, CI, runtime or deployment proof.

<!-- cockpit:ref command=work-metrics --> Metrics expose their retained history coverage. Creation-to-first-movement time uses bounded Git creation evidence and immutable current-generation movement history when available. Missing history remains partial or unavailable; it is never converted to a zero-duration result.

<!-- cockpit:ref command=work-sweep --> <!-- cockpit:ref command=work-reverse --> The sweep groups untouched drafts by creation day and programme. When a group contains three or more, it proposes retaining the earliest identity and parking the others. Applying it persists the prior status; reversal checks the current parked state and its recorded provenance. Human parking is not automatically reversed.

## Verify and grade independently

<!-- cockpit:ref command=work-execute --> <!-- cockpit:ref command=work-review --> <!-- cockpit:ref command=work-grade --> Execution uses the accepted contract’s declared verification commands. After substantial implementation and before grading, `work-review` authenticates the current subject and performs simplification followed by independent code and security review. Findings, dispositions and affected-proof reruns are retained. `work-grade` repeats the final review sequence, runs final declared verification and then invokes the independent grader. Changed authority refuses before grading. Completion requires three distinct non-author reviewers, current evidence and an exclusive lock through readback and the completion sentinel.

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
