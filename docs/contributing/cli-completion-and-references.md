# CLI completion and generated references

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

## Generated references

[`scripts/references.ts`](../../scripts/references.ts) renders the CLI reference, the
configuration reference, the command list, the capability matrix, the installable adopt-cockpit
skill and the remedies table between troubleshooting's `cockpit:diagnostic-index` markers, all from
the working tree. `npm run references` writes whatever differs; CI runs it and fails on
`git diff --exit-code`, so a page that does not match its sources cannot merge.

The remedies table lists a code only when every place that raises it states the same literal fix,
or a hand-written troubleshooting section names it. [`scripts/diagnostic-inventory.ts`](../../scripts/diagnostic-inventory.ts)
reads those codes and fixes from production source. Capability rows come from the shipped
restriction, instruction and skill owners; the renderer never upgrades their evidence strength.
