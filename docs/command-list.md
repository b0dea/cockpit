# Command list

<!-- cockpit:verified version=0.0.0 -->

The command table supplies this list.

- `cockpit init`: Preview or accept one explicit bootstrap target in an existing checkout.
- `cockpit document`: Describe an existing cockpit as attributed cockpit.toml content.
- `cockpit registry-resolve`: Resolve a validated legacy registry into sourceable shell data.
- `cockpit setup`: Acquire and wire declared sibling repositories.
- `cockpit sync`: Synchronize canonical generated environment files.
- `cockpit check`: Check canonical generated environment files for drift.
- `cockpit selftest`: Probe generated harness controls with explicit measured specifications.
- `cockpit upgrade` (experimental): Inspect a reviewable upgrade sequence without applying changes.
- `cockpit up`: Start or resume the declared environment.
- `cockpit sleep`: Release this holder and stop an unshared environment.
- `cockpit session`: Keep the environment available for one command, then release it.
- `cockpit down`: Remove the selected generated runtime.
- `cockpit reset`: Preview or interactively approve an exact reset.
- `cockpit runtime`: Measure the local container runtime (runtime measure) and record its support row.
- `cockpit sibling`: Add or remove a repository in cockpit.toml (sibling add, sibling remove).
- `cockpit preflight`: Evaluate the authenticated environment gate.
- `cockpit doctor`: Report read-only environment diagnostics.
- `cockpit logs`: Collect bounded logs for one declared service.
- `cockpit baseline-record` (experimental): Record an explicitly confirmed environment baseline.
- `cockpit work-intake` (experimental): Prepare a source-bound work order.
- `cockpit work-status` (experimental): Report current work-order state.
- `cockpit work-accept` (experimental): Interactively accept the exact current work order.
- `cockpit work-renew` (experimental): Interactively renew a changed work-order contract.
- `cockpit work-resume` (experimental): Resume the next executable step of the single active work order.
- `cockpit work-recover` (experimental): Inspect or explicitly recover one interrupted work lock.
- `cockpit work-execute` (experimental): Execute one admitted work-order step.
- `cockpit work-record` (experimental): Persist current work-order progress.
- `cockpit work-review` (experimental): Review the current accepted work order.
- `cockpit work-sweep` (experimental): Inspect or apply a reversible work-order sweep.
- `cockpit work-reverse` (experimental): Reverse an authenticated work-order sweep.
- `cockpit work-programme-mint` (experimental): Mint the next declared programme work order.
- `cockpit work-metrics` (experimental): Report attributed work-order metrics.
- `cockpit work-grade` (experimental): Independently grade the current accepted work order.
- `cockpit browser-drive` (experimental): Drive the declared application browser surfaces.
- `cockpit browser-accessibility` (experimental): Collect bounded application accessibility observations.
- `cockpit browser-screenshot` (experimental): Capture the declared application surfaces.
- `cockpit browser-debugger` (experimental): Prepare an explicitly requested browser debugger.
- `cockpit test-run`: Run a declared product gate with honest selection.

## Consumer documentation pipeline

```yaml
documentation-pipeline:
  generate: <declared producer command>
  check: <declared byte comparison command>
  named-references: <declared reference validation command>
```
