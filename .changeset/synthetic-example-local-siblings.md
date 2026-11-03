---
"@b00dea/cockpit": patch
---

The synthetic example declares its `web` repository as an existing checkout (`acquire = "none"`) instead of with a local-path remote that `preflight` refuses, and the tutorial says that a sibling `setup` clones needs a hosted https or ssh remote.
