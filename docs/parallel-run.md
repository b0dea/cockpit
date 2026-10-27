# Comparing an existing environment

<!-- cockpit:verified version=0.0.0 -->

This guide is for teams comparing an existing bring-up path with cockpit, side by side, in an
isolated checkout before switching. Comparison only reports evidence: changing a default,
removing the old path or publishing stays a separate decision you make.

## Prepare the exact subject

Keep the active checkout read-only. Review its revision, complete dirty status and material input
bytes before reproducing them in a separate linked checkout. Exclude secrets, database dumps,
browser state and product evidence. A matching list of dirty paths does not establish matching bytes.

The versioned fixture binds both revisions, the installed package digest, material input digests,
command invocations and expected owner-observed post-state digests. Its five adoption rows cover
registry, environment, surfaces, guards and grading. Record `documented-only` until that layer has
accepted migration evidence; a legacy implementation does not establish migration into cockpit.

All seven shared verbs are required: preflight, up, down, reset, doctor, logs and seed. Declared
extras apply to both implementations. Bind seed to the actual bootstrap operation. Rendering
configuration is not a seed operation. Do not invent a command wrapper or an observation digest to
make a fixture validate. The generated [CLI reference](cli-reference.md) owns the accepted flags.

## Validate before execution

From the isolated checkout, validate the reviewed fixture without starting the runtime:

```sh human-only:reviewed-subject
cockpit compare validate --fixture fixtures/cockpit/comparison.json --json
```

Validation establishes the fixture's structure. It does not establish live source identity, runtime
ownership, equivalence or real use. Unavailable, oversized, unsafe or malformed inputs
refuse with `COMPARISON_UNAVAILABLE`.

After reviewing the configuration, package input and runtime selection, run:

```sh human-only:runtime
DOCKER_CONTEXT=reviewed-context cockpit compare run --fixture fixtures/cockpit/comparison.json --config cockpit.toml
```

Use an attached terminal to review the exact reset preview. JSON or unattended execution cannot
supply reset approval. The runner authenticates the selected checkout, active-checkout exclusion,
package and source bytes, executable identities, lifecycle holder and port family before executing
commands and before and after every command, including final teardown. The post-teardown check
observes source identity only after confirming the exact released holder state. A changed identity
refuses and retains the checkout.
Only bounded owned cleanup may run; an unexplained failure is not permission to remove more.

Raw stdout, stderr, exit status and owner observations remain evidence. Normalization accepts only
declared exact timestamp, absolute-path, port and duration candidates. An undeclared difference
fails. Preserve the raw receipts even when a normalized comparison passes.

## Measure startup and real use

Startup evidence covers empty, seeded and restored data. Each mode requires five paired runs with
alternating order, equivalent initial state and both implementations healthy within their bound.
Compare median invocation-to-healthy durations with zero tolerance: a slower cockpit median fails.
Synthetic controls prove the classifier, not an actual product's startup time.

Keep raw receipts under an ignored evidence directory. Reset-owned artifacts must be separate from
the durable real-use ledger. The CLI reads one bounded JSON ledger; a `.jsonl` filename does not
change that format. You record ten consecutive working days, all data modes, every shared
command and extra, actual receipt digests, explained differences and a dated sign-off.

```sh human-only:operator-ledger
cockpit compare status --fixture fixtures/cockpit/comparison.json --ledger .cockpit/parallel-run/real-use.jsonl --json
```

A structurally valid ledger returns `PARTIAL`, `satisfiesGate: false` and
`operatorAuthentication: required`. Invalid, stale, unsigned, gapped or synthetic rows cannot pass.
The CLI neither writes the ledger nor authenticates that a person was present. Repeated
synthetic runs cannot replace ten real working days.

## Retain rollback

Keep the existing implementation frozen and invocable while evidence is collected. Review the
exact selector and rollback invocation before changing a default. Comparison output contains no
authority to flip that selector or delete either fallback. Preserve both until you accept the
required real-use and post-cutover observations and separately decide to remove one.
