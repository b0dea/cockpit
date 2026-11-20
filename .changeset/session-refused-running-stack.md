---
'@b00dea/cockpit': patch
---

Sessions no longer refuse a running stack that nothing changed, and a slow lock write can no longer be taken over.

- `up` and `session` no longer compare the caller's `PATH`, or where on it `docker` was found, with the shell that started the stack. A session an agent tool started, with a different `PATH` than the terminal, was refused the running stack as one "running an earlier version", and its closing `sleep` then stopped it. A stack still running from an earlier cockpit is refused this way once after the upgrade; run `down`, then `up`.
- When `up` cannot plan from its runtime readings, for example because they outlasted their window on a loaded machine, it says so instead of naming an earlier version of the stack.
- A command now writes its lock owner record before the lock exists. On a loaded machine a slow write left the lock looking abandoned, and another command took it over while the first was still using it.
