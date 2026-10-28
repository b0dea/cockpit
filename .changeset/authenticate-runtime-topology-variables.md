---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Resolve cockpit-authenticated ownership, port, and sibling variables during runtime topology
admission, prevent project `.env` bytes from changing any runtime Compose command, keep service
environment-file contents out of evidence while preserving them in containers, and align the live
runtime probe's volume labels with that authenticated ownership projection.
