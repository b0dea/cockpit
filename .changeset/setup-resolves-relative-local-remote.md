---
"@b0dea/cockpit": patch
---

`setup` now clones a sibling whose `remote` is a relative local path and passes its own check afterwards.

- A relative local `remote` resolves against the siblings root before cloning and before it is compared with the checkout's `origin`. Previously Git recorded the absolute path and `setup` failed with `SETUP_REMOTE_MISMATCH`.
- URL and `host:path` remotes are unchanged.
