# CLI completion and generated references

<!-- cockpit:verified version=0.0.0 -->

This page is for people working on cockpit itself: how a command reports that it finished, and how
the generated reference pages are kept current with the source.

## Command completion and interactive decline

Public CLI outcomes in `--json` mode carry a bounded invocation record with the command name, floored
monotonic duration in milliseconds, resolved configuration path when present, and one exit status.
Human-mode runs print no record; the process exit code is the status:

| Exit | CLI meaning |
| --- | --- |
| `0` | Success. |
| `2` | Failure. |
| `130` | Clean interactive cancellation. |

`session` is the exception: once cleanup completes it exits with its command's own status, as the
lifecycle section of the user guide `docs/environment.md` describes.

These CLI completion statuses are separate from the guard adapters' decision encoding. The
[CLI application](../../packages/cockpit/src/cli.ts) measures elapsed time;
[invocation records](../../packages/cockpit/src/invocation.ts) validate the common completion fields.

Interactive reset and baseline decline waits for cleanup before returning exit 130 with no
result. A thrown decline cleanup reports failure instead of cancellation. JSON mode, CI, and
non-terminal input cannot open an interactive confirmation. Noninteractive reset remains a preview;
baseline requires interaction. These boundaries belong to the
[operator application](../../packages/cockpit/src/environment/operator-application.ts).

## Reference currentness and ownership

The maintainer [reference operations](../../scripts/diagnostic-inventory.mjs) verify one
committed HEAD, its implementing source and shipped assets, package and build inputs, and the
matching built owner bytes. The [reference renderer](../../packages/cockpit/src/references/generate.ts)
derives four complete reference files and the diagnostic index inside troubleshooting's fixed
marker region. Capability rows come from shipped restriction, instruction, and skill owners;
the renderer does not upgrade their evidence strength.

The canonical repository documentation check, `npm run lint:docs`, compares all five generated
products read-only after its Markdown checks. Missing or stale copies fail. Explicit-path and
evidence modes are scoped checks and do not establish canonical reference currentness.

Publication uses the shared
[transaction owner](../../packages/cockpit/src/generated-environment/transaction.ts). Its reference
ownership record is separate from consumer generated-environment ownership. Initial admission
captures exact stage-0 Git index rows and verifies immutable blobs by object identifier;
working-tree bytes alone cannot establish initial ownership. Later publication verifies the
prior reference record and owned bytes. Changed owned files or an edited owned index are refused.

The transaction binds troubleshooting's complete preimage, owned region, postimage, and foreign
prefix and suffix. It preserves every byte outside that region, revalidates source, build,
bootstrap, and ownership observations, and avoids replacement for identical output. A local
reference publication does not establish a public release or native enforcement.

For a refusal, find the diagnostic in the troubleshooting guide, `docs/troubleshooting.md`. Do not
edit an ownership record, evidence bundle, or generated control to conceal the refusal.
