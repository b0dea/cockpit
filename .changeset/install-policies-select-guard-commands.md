---
"@b00dea/cockpit": patch
---

`[[environment.install_policies]]` rows drop `volume`, `install` and `load_probe`. Nothing ran them once cockpit stopped generating the Compose environment, so a row now holds only what takes effect: `toolchain` and `lockfile`, which select the row for a sibling, and the optional `build` and `test` commands the guard allows in that checkout. A configuration that still sets one of the removed fields is refused as an unknown key.
