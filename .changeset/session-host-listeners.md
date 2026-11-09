---
"@b00dea/cockpit": patch
---

`preflight` and `doctor` accept a host process listening on a leased port that Compose does not publish when the `cockpit session` holding the stack started it. Until now every such port had to be free, so a dev server or fixture server kept on the host and started inside `session` failed health with `PORT_FAMILY_COLLISION`. The listener counts as the stack's only when the session is still running with its recorded process ID and start identity, every process listening on the port (from `lsof` on macOS, `ss` from iproute2 on Linux) descends from that session's wrapper and reads the same before and after the listing, its sockets cover every loopback address that answered and none belongs to a process the listing cannot name, and the same proof holds when read again before the verdict. A server started from another terminal or after a plain `up`, one another session, checkout or user started, and one that outlived its session still fail, and the finding now says why. While a session holds the stack, health is unavailable rather than passing when the socket listing or `ps` cannot be read.

`up` run inside a session now also refuses a `COCKPIT_SESSION_PROCESS` that names a process it does not run under, since a recorded session now vouches for its descendants' listeners.
