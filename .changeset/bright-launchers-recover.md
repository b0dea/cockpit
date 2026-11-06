---
"@b00dea/cockpit": patch
---

Printed recovery commands and generated testing guidance use the installed package entrypoint so they work under pnpm without weakening launcher checks. Suggested init commands quote their root paths, and browser harness registration guidance includes the required configuration argument.
