---
"@b00dea/cockpit": patch
---

`doctor` and `preflight` now give one finding for a stack they cannot read, whether every session that held it has ended, a session still holds it, or Docker cannot be reached or cannot list its services. They still run the checks that need no running stack. Before, they added about eighteen "evidence is missing" and failed-producer errors, for the Git working tree, machine floors and agent surfaces among others.

When Docker cannot be read, that finding is `RUNTIME_UNAVAILABLE` instead of calling the stack asleep, and the machine-floor checks Docker measures are reported as not applicable. A stack whose services Docker still lists is no longer called asleep either.
