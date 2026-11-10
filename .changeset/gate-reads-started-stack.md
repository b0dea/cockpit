---
"@b00dea/cockpit": patch
---

A gate stage with `requires_stack = true` now runs against the stack a separate `up` started. `test-run`, and a work-order check that names a gate, asked for the stack's port lease under the gate's own session identity, which holds no lease. So after a successful `up` and a healthy `ps`, the gate ran no stage and reported DEGRADED with `stack unavailable: authenticated runtime observation failed: retained port authority is unavailable`. The same mismatch made `ps`, `logs`, `exec`, `restart` and `rebuild` refuse a stack started under another identity, such as `ps` outside a `cockpit session` whose wrapper started the stack, or inside a session that joined a stack a plain `up` started. These commands now read the ports as the holder the stack's lifecycle record names. That holder must still hold this checkout's active lease, so a stack whose lease was released or removed, or whose holder is recorded for another checkout, is still refused.
