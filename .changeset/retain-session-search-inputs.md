---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Retain the exact executable search environment while preparing a supervised session, so ambiguous Windows `PATH` or `PATHEXT` spellings are refused before environment bring-up. The foreground process continues to receive only defined environment values.
