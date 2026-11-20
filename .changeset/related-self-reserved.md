---
'@b00dea/cockpit': patch
---

A `[guards] related_checkouts` entry that names the cockpit's own checkout, or a directory holding it, no longer refuses every write in the cockpit. One `cockpit.toml` serves every checkout of a product, so an entry naming the product checkout is the cockpit itself when the guard runs there.
