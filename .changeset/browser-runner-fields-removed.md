---
"@b00dea/cockpit": patch
---

`[browser]` drops the fields only the removed browser runner read: `images.runner`, `artifacts.runner`, `artifacts.debugger` and `headed`. The runner script is no longer shipped, and `cockpit browser debugger` refuses with the reason, since nothing can prepare a headed debugger. `browser drive` and `browser screenshot` keep working through the local project client.
