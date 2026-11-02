---
"@b0dea/cockpit": patch
---

`baseline-record` now records a baseline against a running stack. It previously refused every time with `EVIDENCE_UNAVAILABLE`.

- The stability capture uses its own output limit instead of the larger limit sized for logs, which the capture refused.
- The content hash follows `/proc/1/exe`, which is a symlink, instead of finding no files and failing.
- Confirming the preview no longer reports `baseline runtime topology changed` when nothing changed.
- When observation fails, the refusal now says why instead of only `baseline evidence observation is unavailable`.
