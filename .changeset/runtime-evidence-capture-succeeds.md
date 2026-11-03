---
"@b00dea/cockpit": patch
---

A test gate that reads the running stack's runtime evidence now captures it. The capture previously refused every time with `EVIDENCE_UNAVAILABLE`.

- The stability capture uses its own output limit instead of the larger limit sized for logs, which the capture refused.
- The content hash follows `/proc/1/exe`, which is a symlink, instead of finding no files and failing.
