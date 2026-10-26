# Command list

<!-- cockpit:verified version=0.0.0 -->

The command table supplies this list.

- `cockpit init`: Preview or accept one explicit bootstrap target in an existing checkout.
- `cockpit compare`: Validate an isolated comparison, run it, or inspect its operator ledger.
- `cockpit document`: Describe an existing cockpit as attributed cockpit.toml content.
- `cockpit registry-resolve`: Resolve a validated legacy registry into sourceable shell data.
- `cockpit setup`: Acquire and wire declared sibling repositories.
- `cockpit sync`: Synchronize canonical generated environment files.
- `cockpit check`: Check canonical generated environment files for drift.
- `cockpit selftest`: Probe generated harness controls with explicit measured specifications.
- `cockpit upgrade`: Inspect a reviewable upgrade sequence without applying changes.
- `cockpit up`: Start or resume the declared environment.
- `cockpit sleep`: Release this holder and stop an unshared environment.
- `cockpit session`: Keep the environment available for one command, then release it.
- `cockpit down`: Remove the selected generated runtime.
- `cockpit reset`: Preview or interactively approve an exact reset.
- `cockpit preflight`: Evaluate the authenticated environment gate.
- `cockpit doctor`: Report read-only environment diagnostics.
- `cockpit logs`: Collect bounded logs for one declared service.
- `cockpit baseline-record`: Record an explicitly confirmed environment baseline.
- `cockpit work-intake`: Prepare a source-bound work order.
- `cockpit work-status`: Report current work-order state.
- `cockpit work-accept`: Interactively accept the exact current work order.
- `cockpit work-renew`: Interactively renew a changed work-order contract.
- `cockpit work-resume`: Resume the next executable step of the single active work order.
- `cockpit work-recover`: Inspect or explicitly recover one interrupted work lock.
- `cockpit work-execute`: Execute one admitted work-order step.
- `cockpit work-record`: Persist current work-order progress.
- `cockpit work-review`: Review the current accepted work order.
- `cockpit work-sweep`: Inspect or apply a reversible work-order sweep.
- `cockpit work-reverse`: Reverse an authenticated work-order sweep.
- `cockpit work-programme-mint`: Mint the next declared programme work order.
- `cockpit work-metrics`: Report attributed work-order metrics.
- `cockpit work-grade`: Independently grade the current accepted work order.
- `cockpit browser-drive`: Drive the declared application browser surfaces.
- `cockpit browser-accessibility`: Collect bounded application accessibility observations.
- `cockpit browser-screenshot`: Capture the declared application surfaces.
- `cockpit browser-debugger`: Prepare an explicitly requested browser debugger.
- `cockpit test-run`: Run a declared product gate with honest selection.

## Consumer documentation pipeline

```yaml
documentation-pipeline:
  generate: <declared producer command>
  check: <declared byte comparison command>
  named-references: <declared reference validation command>
```
