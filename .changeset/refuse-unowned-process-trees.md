---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Refuse ordinary process execution on Windows before spawning because child exit cannot prove that its descendants stopped. Preserve process-group execution on supported hosts and issue no execution receipt or compensation for an unstarted command.
