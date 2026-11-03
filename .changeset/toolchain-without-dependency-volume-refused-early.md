---
"@b00dea/cockpit": patch
---

A sibling with a `toolchain` other than `"none"` in a generated environment must now have exactly one generated service, with exactly one dependency volume mounted that an install policy for that toolchain fills. Every command that reads `cockpit.toml` refuses any other shape with `GENERATED_DEPENDENCY_VOLUME_MISSING`, naming the sibling field and the fix. Before, `check` and `doctor` passed it, and `up` refused it with `EXECUTION_PRECONDITION_CHANGED` "generated lifecycle source or runtime identity changed" only after it had started the containers, which kept running until `down`.

`EXECUTION_PRECONDITION_CHANGED` from `up` and `session` now carries a fix. When `cockpit.toml` or the running stack changes while `up` runs, the refusal says to run `down` and then `up` again.
