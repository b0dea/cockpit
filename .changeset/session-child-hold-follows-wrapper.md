---
"@b0dea/cockpit": patch
---

A hold that `up` re-adds inside a `cockpit session`, after a `sleep` there released it, is now tied to the session wrapper's process. Previously it recorded no process, so a wrapper killed afterwards left a hold that no later command released. The wrapper passes its process ID and start time in `COCKPIT_SESSION_PROCESS`; `up` checks that process again and refuses with `CLI_USAGE_INVALID` when the wrapper has ended.
