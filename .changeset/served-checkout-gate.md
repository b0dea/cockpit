---
'@b00dea/cockpit': patch
---

Preflight and doctor now fail when a checkout recorded by `cockpit use` no longer exists, as `up` already refuses it. Before, they only warned, so the gate passed a stack `up` could not start.
