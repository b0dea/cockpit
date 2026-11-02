---
"@b0dea/cockpit": patch
---

A `cockpit session` hold now survives a wall-clock step on Linux, and a hold whose start could not be read is released once its process is gone.

- On Linux a session is identified by its start in clock ticks since boot, read from `/proc`, instead of the wall-clock start `ps` derives from the boot time. An NTP correction or a resumed VM no longer makes a running session read as gone, so another session's `down` or `reset` can no longer stop its stack, and an `up` inside the session is no longer refused.
- A session whose start could not be read (no `ps` or `/proc` access) recorded a hold that was never released after a SIGKILL. It is now released once its process ID is gone.
