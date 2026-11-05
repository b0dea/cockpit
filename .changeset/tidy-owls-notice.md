---
"@b00dea/cockpit": patch
---

Recognize a pnpm package link as installed when it resolves to the exact Cockpit copy running the readiness check. Keep guard binding and launcher verification intact, and retain warnings for unrelated, missing or cyclic links.
