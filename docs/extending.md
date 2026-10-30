# Extending cockpit

<!-- cockpit:verified version=0.0.0 -->

Extend declarations at an existing seam and keep product behavior beside `cockpit.toml`. Cockpit is
not a plugin host: an extension remains ordinary version-controlled product code, while cockpit
manages only the generated files listed in its ownership manifest.

## Choose the seam

| Need | What to declare | Why this seam exists | How to use it |
| --- | --- | --- | --- |
| Product instructions, skills, agents or hooks | `[[surfaces.overlays]]` | Add product context without forking shipped surfaces. | Give the overlay a stable name, feature and complete source bytes. Use `replaces` only for an intentional core replacement. |
| Existing Compose stack | `[environment].compose_files` | Keep your own Compose file as the source of truth. | Declare its paths and port variables; cockpit writes only its label override. |
| Generated Compose stack | `[environment.generated]` | Derive a small stack from one short declaration. | Declare services, mounts and ports; do not add a second generator. |
| Service health | `[environment.generated.services.health]` | Make readiness a declared, postchecked property instead of a delay. | State the property, exact probe, interval, timeout and retry limits beside the service. |
| Product data plane | `[environment.generated.data]` | Put seed, migration and verification steps into the lifecycle that runs and checks them. | Declare exact operations and postchecks beside the service they belong to. |
| Dependency installation | `[[environment.install_policies]]` | Bind one toolchain and lockfile to a dependency volume. | Declare the install and load probe; add build or test commands only when the product owns them. |
| External tool server | `[mcp]` and `sibling[].derives.mcp_sources` | Declare one server once and generate it for every harness that supports MCP. | Point a sibling at its `mcp-json` declaration source and approve the server name centrally; keep credentials outside tracked files. |
| Extra guard policy | `[[guards.allow]]` and `[[guards.deny]]` | Refine prompts for exact product commands while preserving cockpit's hard boundaries. | Match an exact command, starting with its executable, and state the reason. Prefer a deny with a safe fix when a known alternative exists. |
| Your own automation | Files beside `cockpit.toml` | Keep bespoke build, test and release logic usable without cockpit. | Put scripts, task-runner files and Compose inputs outside generated paths, then refer to them from declarations and overlays. |
| Additional harness | `[[surfaces.harnesses]]` | Record a complete, honest capability matrix without pretending an unsupported feature works. | Declare every feature with its spelling in that tool or the reason it is unavailable; verify each claimed control beside a broken control. |

## Build beside cockpit

Keep the product's `Makefile`, task runner or scripts your own. Expose a narrow target such as
`make verify`, add a skill overlay that tells agents when to use it, then add an exact guard allow
with a reason. Give the skill its own short procedure with `loading: pull` and `budget: uncapped`
frontmatter; keep that procedure outside the entry point so agents load it only when needed. Cockpit can generate the skill and permission while the build logic stays directly
runnable by people and CI. The [extended example](../examples/extended/README.md) shows this pattern.

Generated ownership is the upgrade boundary. A later `sync` may replace the files cockpit generated
and reports a changed overridden core declaration, but it does not adopt or overwrite
the files beside them. Review `cockpit upgrade` before changing installed versions and retain product logic
outside generated paths.

Give generated outputs portable relative names so the same committed checkout can be shared across
filesystems. Avoid reserved device names, stream syntax, trailing dots or spaces, and directory names
that differ only by case or Unicode normalization. Keep every path component within both 255 UTF-16
code units and 255 UTF-8 bytes. Rename an invalid overlay output, then review `cockpit sync --dry-run`
before publishing it.
