---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Refuse redirected or non-regular unattended-init inputs and keep inferred repository evidence within its declared root.

Upgrade: replace any symlinked or non-regular answers source with a plain UTF-8 TOML file before rerunning init.
