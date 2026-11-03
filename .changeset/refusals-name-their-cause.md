---
"@b00dea/cockpit": patch
---

Refusals that come from a caught error now say why. A filesystem or process failure appends its system error, for example `EACCES: permission denied, open '<path>'`. Any other failure appends only its error class, because parser and child-process messages can quote file contents or environment values.

- An unparseable `package.json` is reported as `TEAM_METADATA_UNAVAILABLE` with the parse failure. It was previously reported as `COCKPIT_VERSION_MISMATCH` with a missing pin.
