---
"@b0dea/cockpit": patch
---

A generated-environment operation with `location = "host"` must name `node` as `argv[0]`, because Node is the only host executable cockpit binds. Any other executable could never run: `up` reported only `generated environment observations are incomplete`. Every command now refuses such a configuration on load with `CONFIG_HOST_EXECUTABLE_UNSUPPORTED`, names the operation, and says how to fix it.

Host-located data operations that name `node` now plan and run. They were previously refused with `data prerequisite did not resolve to a confined execution step`.
