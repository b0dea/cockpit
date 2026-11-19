---
'@b00dea/cockpit': patch
---

A stack held only by sessions that have ended is no longer treated as running. Doctor now says such a stack is asleep, and `up` after `down` starts it instead of refusing with a claim left by an earlier command and sending you to `down` again. A session still counts as holding the stack while its process runs, or while cockpit cannot confirm it is gone, for example when a sandbox blocks `ps`.
