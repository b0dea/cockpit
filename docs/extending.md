# Extending cockpit

<!-- cockpit:verified version=0.0.0 -->

Extend declarations at an existing seam and keep product behavior beside `cockpit.toml`. Cockpit is
not a plugin host: an extension remains ordinary version-controlled product code, while cockpit
owns only the generated files named in its ownership manifest.

## Choose the seam

| Need | What to declare | Why this seam exists | How to use it |
| --- | --- | --- | --- |
| Product instructions, skills, agents or hooks | `[[surfaces.overlays]]` | Add product context without forking shipped surfaces. | Give the overlay a stable name, feature and complete source bytes. Use `replaces` only for an intentional core replacement. |
| Existing Compose stack | `[environment].compose_files` | Keep a product-owned Compose file authoritative. | Declare its paths and port variables; cockpit writes only its label override. |
| Generated Compose stack | `[environment.generated]` | Derive a small stack from one bounded declaration. | Declare services, mounts and ports; do not add a second generator. |
| Service health | `[environment.generated.services.health]` | Make readiness a declared, postchecked property instead of a delay. | State the property, exact probe, interval, timeout and retry bounds beside the service. |
| Product data plane | `[environment.generated.data]` | Put seed, migration and verification steps into the lifecycle that authenticates them. | Declare exact operations and postchecks beside the owning service. |
| Dependency installation | `[[environment.install_policies]]` | Bind one toolchain and lockfile to an owned dependency volume. | Declare the install and load probe; add build or test commands only when the product owns them. |
| External tool server | `[mcp]` and `sibling[].derives.mcp_sources` | Publish one neutral server declaration through measured harness adapters. | Point a sibling at its `mcp-json` declaration source and approve the server name centrally; keep credentials outside tracked files. |
| Extra guard policy | `[[guards.allow]]` and `[[guards.deny]]` | Refine prompts for exact product commands while preserving cockpit's hard boundaries. | Match a bounded command vector, starting with its executable, and state the reason. Prefer a deny with a safe fix when a known alternative exists. |
| Product-owned automation | Files beside `cockpit.toml` | Keep bespoke build, test and release logic usable without cockpit. | Put scripts, task-runner files and Compose inputs outside generated paths, then refer to them from declarations and overlays. |
| Additional harness | `[[surfaces.harnesses]]` | Record a complete, honest capability matrix without pretending an unsupported feature works. | Declare every feature and its measured spelling or unavailability reason; verify each claimed control beside a broken control. |

## Build beside cockpit

Keep the product's `Makefile`, task runner or scripts consumer-owned. Expose a narrow target such as
`make verify`, add a skill overlay that tells agents when to use it, then add an exact guard allow
with a reason. Give the skill its own short procedure with `loading: pull` and `budget: uncapped`
frontmatter; keep that procedure outside the entry point so agents load it only when needed. Cockpit can publish the skill and permission while the build logic stays directly
runnable by people and CI. The [extended example](../examples/extended/README.md) shows this pattern.

Generated ownership is the upgrade boundary. A later `sync` may replace authenticated cockpit-owned
outputs and reports a changed overridden core declaration, but it does not adopt or overwrite
beside files. Review `cockpit upgrade` before changing installed versions and retain product logic
outside generated paths.
