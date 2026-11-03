# Extending cockpit

This page is for integrators adding product-specific behaviour to a cockpit: which declaration to
use for each need, and how to keep your own build logic beside cockpit. Cockpit is not a plugin
host. An extension stays ordinary version-controlled product code; cockpit manages only the
generated files listed in its ownership manifest.

## Choose the seam

| Need | What to declare | Why this seam exists | How to use it |
| --- | --- | --- | --- |
| Product instructions, skills, agents or hooks | `[[surfaces.overlays]]` | Add product context without forking shipped surfaces. | Give the overlay a stable name, feature and complete source bytes. Use `replaces` only for an intentional core replacement. |
| Existing Compose stack | `[environment].compose_files` | Keep your own Compose file as the source of truth. | Declare its paths and port variables; cockpit writes only its label override. |
| Starting Compose file | `cockpit init --scaffold-compose` | Give a small app with no Compose file one it then owns. | Run it once; edit the written `compose.yml` like any other product file. |
| Service health | a Compose `healthcheck` | Make readiness a checked property instead of a delay. | Give every service a healthcheck; `check` warns on one without. |
| Demo data | `environment.seed` with `resettable_volumes` | Fill the data volumes once the stack is healthy, and again after they are recreated. | Point it at the product's own seed or restore command; write that command to be rerun. |
| Vendor stubs, TLS | services in your Compose file | Keep the stack plain Compose. | Follow [Compose patterns](compose-patterns.md). |
| External tool server | `[mcp]` and `sibling[].derives.mcp_sources` | Declare one server once and generate it for every harness that supports MCP. | Point a sibling at its MCP declaration file (a JSON `mcpServers` object) and approve the server centrally by the digest `sync` reports for its declaration; keep credentials outside tracked files. |
| Extra guard policy | `[[guards.allow]]` and `[[guards.deny]]` | Refine prompts for exact product commands while preserving cockpit's hard boundaries. | Match an exact command, starting with its executable, and state the reason. Prefer a deny with a safe fix when a known alternative exists. |
| Your own automation | Files beside `cockpit.toml` | Keep bespoke build, test and release logic usable without cockpit. | Put scripts, task-runner files and Compose inputs outside generated paths, then refer to them from declarations and overlays. |
| Additional harness | `[[surfaces.harnesses]]` | Record a complete, honest capability matrix without pretending an unsupported feature works. | Declare every feature with its spelling in that tool or the reason it is unavailable; verify each claimed control beside a broken control. |

## Build beside cockpit

Keep the product's `Makefile`, task runner or scripts your own, so people and CI can run them
without cockpit:

1. Expose a narrow target, such as `make verify`.
2. Add a skill overlay that tells agents when to use it. Put the procedure in its own file with
   `loading: pull` and `budget: uncapped` frontmatter, so agents load it only when needed.
3. Add an exact guard allow for the target, with a reason.

The [extended example](../examples/extended/README.md) shows this pattern.

Generated ownership is the upgrade boundary. A later `sync` may replace files cockpit generated,
and reports a changed overridden core declaration, but it never adopts or overwrites the files
beside them. Preview `cockpit sync --dry-run` after changing the installed version.

Give generated outputs portable relative names, so one committed checkout works on every
filesystem. Avoid reserved device names, stream syntax, trailing dots or spaces, and directory names
that differ only by case or Unicode normalization. Keep every path component within 255 UTF-16
code units and 255 UTF-8 bytes. To fix an invalid overlay output, rename it and review
`cockpit sync --dry-run` before publishing.
