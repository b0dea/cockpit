---
"@b00dea/cockpit": patch
---

Allow an existing private state directory to work under a narrowly scoped sandbox write grant
without also requiring writes to the home directory and other ancestors. Missing state directories
still require write access where creation starts, and unsafe ownership, symlinks and denied writes
remain refusals.
