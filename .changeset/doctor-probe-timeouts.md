---
'@b00dea/cockpit': patch
---

Commands behave better on a busy machine:
- `doctor` and `preflight` name a probe that ran out of time and how long it had, instead of reporting only that an observation producer failed. A failed producer's own refusal reason now follows its name.
- A runtime version probe that timed out no longer tells the reader to install or start Docker.
- `down`, `reset` and reclaim wait, within a bound, for a container or volume removal Docker is still finishing, instead of failing on the first timeout; if Docker never finishes, the message says so and names the timeout.
