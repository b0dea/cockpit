---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Retire startup progress only after authenticated `down` completes, allowing a synchronized
configuration to start a new generated environment. Preserve the final claim when retirement
cannot be verified, and retain the generated identity across `sleep` and `reset`.
Safely resume an interrupted removal when fresh authenticated evidence proves the exact persisted
target is already absent; reset still requires approval of every remaining target.
