---
"@b00dea/cockpit": patch
---

`init` on a cockpit that declares no runtime now ends at the new `surfaces-verified` stage instead of reporting `environment-verified`, since nothing verified an environment. Such a cockpit reads its env schema status from `cockpit doctor`.
