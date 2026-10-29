---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Give each authenticated physical dependency volume its own install lock and durable stamp, so a
new generated volume receives a fresh install and load probe while same-volume compatibility
changes continue to refuse.
