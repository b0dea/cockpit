---
"@b00dea/cockpit": patch
---

Give `check` and `preflight` the observation search path `sync` and `doctor` already use. With a relative `PATH` entry, `check` no longer reports `COMPOSE_TOPOLOGY_UNAVAILABLE` and `preflight` no longer stops at "preflight observation source is unavailable"; when Git cannot be selected, both `doctor` and `preflight` now give the reason.
