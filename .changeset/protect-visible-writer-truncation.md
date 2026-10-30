---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Deny visible writer truncation of the configuration and ownership manifest even with exact command grants. Preserve explicit append and non-truncating writes, and refuse unsupported writer options.
