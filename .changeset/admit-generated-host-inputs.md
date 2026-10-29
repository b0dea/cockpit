---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Check declared generated bind sources, environment-file mounts, build contexts and Dockerfiles
before Compose builds or starts services. Refuse missing, linked or wrong-type inputs within
authenticated sibling roots, and check published browser-runner inputs within the cockpit root.
