---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Preserve the host's exact executable search names while resolving Docker for lifecycle and stable-read commands. Ambiguous Windows `PATH` or `PATHEXT` spellings now refuse before runtime dispatch, while child processes still receive only the bounded runtime environment.
