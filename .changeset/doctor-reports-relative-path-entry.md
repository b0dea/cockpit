---
"@b00dea/cockpit": patch
---

`doctor` warns with `GUARD_SEARCH_PATH_RELATIVE` when the `PATH` it runs with holds a relative or empty entry, which makes the guard ask before every agent command, and names the entry; readiness lists it as `harness-path-absolute`.
