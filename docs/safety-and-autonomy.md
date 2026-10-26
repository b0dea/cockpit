# Safety and autonomy

<!-- cockpit:verified version=0.0.0 -->

Cockpit binds authority to captured invocations and declared resources. This guide explains which
requests are allowed, prompted, denied, or unavailable, and which claims still require operator
evidence. It is for operators reviewing generated controls and agents working within them.

The [command table](../packages/cockpit/src/command-table.ts),
[autonomy launcher](../packages/cockpit/src/autonomy/launcher.ts), and
[guard evaluator](../packages/cockpit/src/guards/evaluator.ts) own these decisions. The generated
[CLI reference](cli-reference.md), [command list](command-list.md), and
[configuration reference](configuration-reference.md) describe their public inputs.

## Outcome vocabulary

| Outcome | Meaning |
| --- | --- |
| `allow` | Evaluation completed without a harder boundary; executable invocations match exact permitted profiles. |
| `ask` | An operator decision is required. This grants no authority by itself. |
| `deny` | A hard boundary forbids the request, even with an exact grant. |
| `unavailable` | Cockpit could not authenticate or safely evaluate the request. No authority is granted. |

The evaluator scans the complete authenticated capture for hard denials before returning an
unavailable or ask result. A softer result encountered earlier cannot hide a later forbidden
operation. Malformed input or an incomplete policy is unavailable before that scan can begin.

## Ordinary and escalated modes

When a launch omits its mode, the launcher uses `ordinary`. An explicitly supplied unknown, empty,
null, or undefined mode is refused. A successful launch remains `instructed`, with the guard
required; source admission alone does not establish native enforcement.

For cockpit commands, ordinary admission requires an exact available public command profile.
The application authenticates the executable and working root; the command resolver checks the
bounded complete argument vector, resolved configuration path, declared services, permitted option
roles, and inspected paths. Internal guard transport and public commands marked unavailable are
excluded. Launch grants can also include the target's admitted native reads and exact declared
project build or test commands. No command-family wildcard becomes ordinary authority.

Escalated mode requires an explicit escalation flag and authenticated, current evidence matching
the registered hook, handler, executable, and launch wiring. An escalation flag set to true in
ordinary mode is refused. Both modes retain hard-deny evaluation, the always-run guard, native
ask or ask-to-deny behavior, exact invocation grants, and read-only instructions. Escalation does
not remove these protections or promote pending evidence.

## Hard controls and prompts

The [guard evaluator](../packages/cockpit/src/guards/evaluator.ts) denies mutation or staging of a
declared environment instance. Staging a containing directory can include that instance and is
also denied. Executable use of a declared hosted database or vendor host is denied at hostname
boundaries. Matching examines executable, argument, and environment-assignment-value roles;
redirects, heredocs, comments, and definitions do not count as executable host use.

Pushes to declared protected branches are hard denials. This includes explicit protected
destinations and `git push --all` or `git push --mirror` when protected branches are declared. Missing or unresolved
destinations, including ambiguous source-only revisions, symbolic aliases, and wildcards, require
an operator decision. An exact grant cannot override either boundary.

Unresolved Git execution context, destructive Git reset or clean forms, staging without explicit
paths, wrapped or environment-modifying commands, and unmatched invocation profiles produce `ask`.
Broad staging can still produce a hard denial if it includes an environment instance. Unsupported
staging options or unproven pathspec grammar produce `unavailable`.

Malformed or oversized input, incomplete policy, escaped or symlinked path evidence, inspection
failure, and exceeded limits also produce `unavailable`. The
[invocation parser](../packages/cockpit/src/guards/invocation-parser.ts) captures bounded input once;
the evaluator accepts only its issued parser product. A reconstructed lookalike has no authority.

## Native adapter behavior

The [transport and adapter owner](../packages/cockpit/src/guards/harness-adapter.ts) translates a
decision without adding grants or weakening hard boundaries:

| Harness | Translation and adapter exit |
| --- | --- |
| Claude Code | Allow, ask, and deny exit 0; ask and deny are carried in native decision JSON. |
| Codex CLI | Ask becomes deny. Allow and deny exit 0; deny is carried in native decision JSON. |
| OpenCode | Ask becomes deny. Allow exits 0; every non-allow decision exits 2. |

Unavailable or malformed decisions exit 2 on every target. Adapter exit 0 alone therefore does
not mean permission was granted.

Guard transport uses a fixed handler argument vector, normalized absolute handler and
working-directory paths, bounded standard input, a five-second timeout, and bounded standard
output and error. Copied plans, failed transport, signals, oversized output, nonzero handler
status, and invalid JSON become unavailable with exit 2. Lexical path normalization in this
adapter does not itself authenticate filesystem identity.

Generated native restrictions remain `instructed` with `pending_evidence`. If an adapter is
unavailable, no target-specific registration or read-only fragment is emitted; the shared guard
file may still be generated. Instruction projections also retain pending evidence. The
[capability matrix](capability-matrix.md) preserves source provenance, measurement dates, and
`human_needed` skill judgments. Historical adapter measurements do not prove current native
enforcement. See [harness surfaces](harness-surfaces.md) for the wider surface estate.

## Command completion and operator decline

Public CLI outcomes carry a bounded invocation record with the command name, floored monotonic
duration in milliseconds, resolved configuration path when present, and one exit status:

| Exit | CLI meaning |
| --- | --- |
| `0` | Success. |
| `2` | Failure. |
| `130` | Clean interactive cancellation. |

These CLI completion statuses are separate from native adapter decision encoding. The
[CLI application](../packages/cockpit/src/cli.ts) measures elapsed time;
[invocation records](../packages/cockpit/src/invocation.ts) validate the common completion fields.

Interactive reset and baseline decline waits for cleanup before returning exit 130 with no
result. A thrown decline cleanup reports failure instead of cancellation. JSON mode, CI, and
non-terminal input cannot open an operator continuation. Noninteractive reset remains a preview;
baseline requires interaction. These boundaries belong to the
[operator application](../packages/cockpit/src/environment/operator-application.ts).

## Reference currentness and ownership

The maintainer [reference operations](../scripts/diagnostic-inventory.mjs) authenticate one
committed HEAD, its implementing source and shipped assets, package and build inputs, and the
matching built owner bytes. The [reference renderer](../packages/cockpit/src/references/generate.ts)
derives four complete reference files and the diagnostic index inside troubleshooting's fixed
marker region. Capability rows come from shipped restriction, instruction, and skill owners;
the renderer does not upgrade their evidence strength.

The canonical repository documentation check, `npm run lint:docs`, compares all five generated
products read-only after its Markdown checks. Missing or stale copies fail. Explicit-path and
evidence modes are scoped checks and do not establish canonical reference currentness.

Publication uses the shared
[transaction owner](../packages/cockpit/src/generated-environment/transaction.ts). Its reference
ownership record is separate from consumer generated-environment ownership. Initial admission
captures exact stage-0 Git index rows and authenticates immutable blobs by object identifier;
working-tree bytes alone cannot establish initial ownership. Later publication authenticates the
prior reference record and owned bytes. Changed owned files or an edited owned index are refused.

The transaction binds troubleshooting's complete preimage, owned region, postimage, and foreign
prefix and suffix. It preserves every byte outside that region, revalidates source, build,
bootstrap, and ownership observations, and avoids replacement for identical output. A local
reference publication does not establish a public release or native enforcement.

For a refusal, use the diagnostic's implementing owner in [troubleshooting](troubleshooting.md).
Do not edit an ownership record, evidence bundle, or generated control to conceal the refusal.

## Evidence and operator holds

Static configuration, source inspection, synthetic fixtures, model self-report, and silence do
not prove native enforcement. The
[native evidence validator](../packages/cockpit/libexec/validate-harness-evidence.mjs) binds exact
current executable and wiring identities, generated-manifest and candidate digests, version,
bounded transcripts, and validation results. Escalation evidence requires distinct ordinary,
escalated, missing, and unknown mode rows, each with candidate and deliberately broken-control
evidence. It expires and is rechecked against current installed wiring at use. Serialized or
copied evidence objects do not reproduce its authority. Cleanup is outside this validator's
evidence contract.

Native prompt behavior requires current measurements; absent evidence remains non-authorizing.
Missing evidence keeps cells `instructed` or `unavailable`, with `human_needed` judgments still
pending. It does not relax hard denials or grant authority. Source tests establish source
behavior; they do not satisfy native, human, bootstrap, or real-use acceptance.

Operator gates keep cutover,
fallback deletion, and gate evaluation under operator control. Real use needs human-paced
evidence, and public publication remains a separate decision. Default changes and release
decisions cannot be inferred from generated references or green source checks.
