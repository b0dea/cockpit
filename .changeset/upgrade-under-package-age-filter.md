---
'@b00dea/cockpit': patch
---

`upgrade` no longer reports "already current" when the package manager's minimum-package-age filter
hid newer releases from the latest lookup. It now refuses with `UPGRADE_LATEST_FILTERED`, names the
registry's real latest the way `doctor` reads it, and gives the exact-version command to run. A failed
install that carries the same filter notice says so. If you ran `upgrade` on such a machine and saw
"already current", run `upgrade <version>` with the latest version from `doctor`.
