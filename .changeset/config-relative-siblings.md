---
"@b0dea/cockpit": patch
---

Resolve sibling roots and lifecycle paths relative to the selected configuration directory so nested cockpit configurations use their declared repositories and Compose files.

Authenticate health observations for nested configurations while rejecting configuration paths outside their checkout. Restore sibling Git health comparisons when the command has a configured home and executable search path.
