# Extending cockpit

Which declaration to use for each need, and how to keep your own build logic beside cockpit. Cockpit
is not a plugin host: an extension stays ordinary version-controlled product code, and cockpit
manages only the generated files in its ownership manifest.

## Choose the seam

| Need | Declare | How |
| --- | --- | --- |
| Product instructions, skills, agents or hooks | `[[surfaces.overlays]]` | Give the overlay a stable name, feature and complete source bytes. Use `replaces` only for an intentional core replacement. |
| Existing Compose stack | `[environment].compose_files` | Declare its paths and port variables; cockpit writes only its label override. |
| Starting Compose file | `cockpit init --scaffold-compose` | Run it once; the written `compose.yml` is yours. |
| Service health | a Compose `healthcheck` | Give every service one; `check` warns on one without. |
| Demo data | `environment.seed` with `resettable_volumes` | Point it at the product's own seed or restore command, written to be rerun. |
| Vendor stubs, TLS | services in your Compose file | Follow [Compose patterns](compose-patterns.md). |
| External tool server | `[mcp]` and `sibling[].derives.mcp_sources` | Point a sibling at its MCP declaration file (a JSON `mcpServers` object) and approve the server by the digest `sync` reports; keep credentials outside tracked files. |
| Extra guard policy | `[[guards.allow]]` and `[[guards.deny]]` | Match an exact command, starting with its executable, and state the reason. Prefer a deny with a safe fix when a known alternative exists. Neither weakens cockpit's hard boundaries. |
| Your own automation | files beside `cockpit.toml` | Put scripts and task-runner files outside generated paths, then refer to them from declarations and overlays. |
| Additional harness | `[[surfaces.harnesses]]` | Declare every feature with its spelling or the reason it is unavailable; verify each claimed control beside a broken control. |

## Build beside cockpit

Keep the product's `Makefile`, task runner or scripts your own, so people and CI can run them
without cockpit:

1. Expose a narrow target, such as `make verify`.
2. Add a skill overlay that tells agents when to use it. Put the procedure in its own file with
   `loading: pull` and `budget: uncapped` frontmatter, so agents load it only when needed.
3. Add an exact guard allow for the target, with a reason.

The [extended example](../examples/extended/README.md) shows this pattern.

Generated ownership is the upgrade boundary. A later `sync` may replace files cockpit generated, but
never adopts or overwrites the files beside them. Preview `cockpit sync --dry-run` after changing
the installed version.

Give generated outputs portable relative names. Avoid reserved device names, stream syntax, trailing
dots or spaces, and directory names that differ only by case or Unicode normalization, and keep
every path component within 255 UTF-16 code units and 255 UTF-8 bytes.
