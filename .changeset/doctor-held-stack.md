---
'@b00dea/cockpit': patch
---

Doctor no longer refuses everything when a session still holds the stack but nothing runs, as happens when a session ends without `sleep` or `down`. It reports what it could check, and says that a session holds the stack and that `up` resumes it or `down` releases it.
