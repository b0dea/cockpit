---
"@b00dea/cockpit": patch
---

A refusal naming a stack's hold now says its process may only be unconfirmed, and asks you to check `ps -p` before the `kill` it suggests, because a pid can have been reused. Cleaning up an attempt also clears week-old socket files that a crash left in cockpit's private temporary directory.
