# CLI completion and generated references

<!-- cockpit:verified version=0.0.0 -->

This page is for people working on cockpit itself: how a command reports that it finished, and how
the generated reference pages are kept current with the source.

## Command completion and interactive decline

In `--json` mode every public CLI outcome carries a bounded invocation record: the command name,
the floored monotonic duration in milliseconds, the resolved configuration path when there is one,
and one exit status. Human-mode runs print no record; the process exit code is the status:

| Exit | CLI meaning |
| --- | --- |
| `0` | Success. |
| `2` | Failure. |
| `130` | Clean interactive cancellation. |

`session` is the exception: once cleanup completes, it exits with its command's own status (see
*Lifecycle and ownership* in the user guide `docs/environment.md`). These statuses are separate
from the guard adapters' decision encoding. The [CLI application](../../packages/cockpit/src/cli.ts)
measures elapsed time; [invocation records](../../packages/cockpit/src/invocation.ts) validate the
common completion fields.

Declining an interactive reset or baseline waits for cleanup, then exits 130 with no result; if
that cleanup throws, the run reports failure instead of cancellation. JSON mode, CI and
non-terminal input cannot open an interactive confirmation, so a noninteractive reset stays a
preview and baseline requires a terminal. The
[operator application](../../packages/cockpit/src/environment/operator-application.ts) owns these
boundaries.

## Reference currentness and ownership

The maintainer [reference operations](../../scripts/diagnostic-inventory.mjs) verify one
committed HEAD: its implementing source and shipped assets, package and build inputs, and the
matching built owner bytes. The [reference renderer](../../packages/cockpit/src/references/generate.ts)
derives the whole-file references and the diagnostic index inside troubleshooting's fixed marker
region. Capability rows come from the shipped restriction, instruction and skill owners; the
renderer never upgrades their evidence strength.

`npm run lint:docs` compares every generated product read-only after its Markdown checks; a missing
or stale copy fails. Its explicit-path and evidence modes are scoped checks and do not establish
that the references are current.

Publication uses the shared
[transaction owner](../../packages/cockpit/src/generated-environment/transaction.ts), with a
reference ownership record separate from consumer generated-environment ownership:

- Initial admission captures exact stage-0 Git index rows and verifies immutable blobs by object
  identifier; working-tree bytes alone cannot establish ownership.
- Later publication verifies the prior reference record and owned bytes, and refuses changed owned
  files or an edited owned index.
- For troubleshooting, the transaction binds the complete preimage, owned region, postimage, and
  foreign prefix and suffix. It preserves every byte outside the region, revalidates source,
  build, bootstrap and ownership observations, and does not replace identical output.

A local reference publication establishes neither a public release nor native enforcement. For a
refusal, look the diagnostic up in the user guide `docs/troubleshooting.md`. Do not edit an
ownership record, evidence bundle or generated control to hide the refusal.
