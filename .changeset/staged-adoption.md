---
'@b00dea/cockpit': patch
---

Let `init` accept an explicit empty Compose list for staged adoption of a runnable product, keeping install policies, testing, guards and answer provenance while skipping runtime questions. Supplied answers that become irrelevant are reported.

**Migration:** `init` on a cockpit that declares no runtime now ends at stage `surfaces-verified`, where it reported `environment-verified`, because nothing verified an environment. A script that reads `result.stage` must accept the new value. Such a cockpit reads its schema status from `cockpit doctor`. Interview state already recorded at the old stage stays valid.
