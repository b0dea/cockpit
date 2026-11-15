---
"@b00dea/cockpit": patch
---

A Node upgrade or a second Node install no longer holds guarded calls. The hook runs Node by the path `sync` found on your search path, such as a package manager's link, and the guard runs under whichever Node is there. `doctor` no longer reports that the Node differs.

Upgrade: run `cockpit sync` once in a terminal, as after every release.
