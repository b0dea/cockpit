---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Deny `git archive` output paths that would truncate cockpit configuration, generated guard
controls, declared environment instances or secret storage, including when `git -C` changes the
command's working directory.

Upgrade: have a human run `cockpit sync --config cockpit.toml` in a terminal to regenerate and
approve the guard.
