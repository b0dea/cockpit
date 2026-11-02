---
"@b0dea/cockpit": patch
---

`registry-resolve` now works on a cockpit installed from a tarball packed from source. It validates the registry and adoption file first, records `COCKPIT_SOURCE_REVISION='development'` with a `COCKPIT_REVISION_UNSTAMPED` warning when the package carries no release commit, and refuses only a malformed revision, with a fix. Adoption-file refusals state the expected five-line format, which the adoption guide now documents.
