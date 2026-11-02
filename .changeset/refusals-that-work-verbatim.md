---
"@b0dea/cockpit": patch
---

Several refusals now say what to do in words that work as written:

- A failed `setup` clone reports `SETUP_CLONE_FAILED` with the remote, the target directory, git's own error and the siblings already cloned, plus a fix, instead of a bare `EXECUTION_STEP_FAILED`. Any failed execution step now carries a bounded, redacted tail of its stderr in the refusal evidence.
- `GENERATED_STALE_APPROVAL_REQUIRED` names `sync --interactive` and the digest to type, and a human `sync --dry-run` prints that digest.
- `runtime measure` with an image that is not local reports `RUNTIME_IMAGE_UNAVAILABLE` and says to pull or build it, instead of telling you to start a runtime that is running.
- A mistyped `--config` in a cockpit checkout no longer suggests restoring the mistyped path from git; it names the configuration the checkout was synced from.
- `MACHINE_COLD_START_EXCEEDED` and the machine-floor refusals (`MACHINE_MEMORY_BELOW_FLOOR`, `MACHINE_CPU_BELOW_FLOOR`, `MACHINE_DISK_BELOW_FLOOR`) state the measured value, the declared limit and the field to change.
