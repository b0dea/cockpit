---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Preserve the host's exact executable search names, including present-but-undefined aliases, across lifecycle, health, destructive, stable-read, and environment-schema composition. Ambiguous Windows `PATH` or `PATHEXT` spellings now refuse before executable inspection or runtime dispatch, while child processes still receive only bounded string-valued environment entries.
